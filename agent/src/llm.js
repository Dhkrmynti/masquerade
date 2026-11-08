// Optional Claude layer: turns a free-form instruction into one structured
// rule plus a short reply. It never touches the chain. Its output goes
// through validateRule, then the normal rule engine, then the vault.
//
// Enabled only when ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is set,
// e.g. in agent/.env. Without it the agent uses the regex parser alone.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import { validateRule } from './rules.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

export const enabled = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let client;
const getClient = () => (client ||= new Anthropic()); // reads the key from the environment

// Every field is required (nullable when unused) so the schema is strict.
const Interpretation = z.object({
  action: z.enum(['rule', 'clarify', 'reject']),
  rule: z
    .object({
      kind: z.enum(['dip', 'rise', 'dca']),
      sym: z.string(),
      amount: z.number().nullable(), // USDG per buy (dip, dca)
      pct: z.number().nullable(), // % move that triggers (dip, rise)
      share: z.number().nullable(), // % of holding to sell (rise)
      every_seconds: z.number().nullable(), // interval (dca)
      repeat: z.boolean(),
    })
    .nullable(),
  reply: z.string(),
});

// Kept byte-stable so it can be cached; per-request facts go in the user turn.
const SYSTEM = `You translate a user's trading instruction for an "envoy" (a trading agent with its own capped wallet) into exactly one rule.

Rule kinds:
- dip: buy a fixed USDG amount of a stock when its price falls pct% below the reference price. repeat=true re-arms from each fill.
- rise: sell share% of the envoy's holding of a stock when its price rises pct% above the reference price. repeat=true re-arms from each fill.
- dca: buy a fixed USDG amount of a stock every every_seconds (minimum 60).

Fill only the fields the kind uses; set the others to null.

Choose action:
- "rule" when the instruction maps to one rule with concrete numbers. If the user gave a range or a vague size, choose a sensible concrete value inside what they said and state it in the reply.
- "clarify" when a number you cannot reasonably infer is missing, or the user asks for several rules at once (ask which one to set first).
- "reject" when the request isn't a rule of these kinds, names a stock that isn't on the envoy's list, or asks for something the envoy can't do (withdrawals, leverage, other wallets, guaranteed profits).

The envoy's vault enforces its own limits (per-order cap, daily buy limit, slippage floor, curfew). You don't need to restate them, but if the rule clearly collides with one, say so briefly in the reply.

Reply in the user's language, in one or two short sentences, plain text, no promises about returns.`;

/**
 * @returns {Promise<null | { action: string, rule?: object, reply: string, error?: string }>}
 *   null when Claude isn't configured or the call failed (caller falls back).
 */
export async function interpret(text, ctx) {
  if (!ctx.client && !enabled()) return null;
  const facts = [
    `Envoy stocks: ${ctx.symbols.join(', ')}`,
    `Current prices (USDG): ${ctx.symbols.map((s) => `${s} ${ctx.prices[s]?.toFixed(2) ?? 'n/a'}`).join(', ')}`,
    `Vault limits: max ${ctx.perOrderMax} USDG per buy, ${ctx.dailyBuyLimit ? ctx.dailyBuyLimit + ' USDG of buys per day' : 'no daily buy limit'}, ${ctx.usdg} USDG in the purse.`,
  ].join('\n');

  let res;
  try {
    res = await (ctx.client || getClient()).messages.parse({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: 'low', format: zodOutputFormat(Interpretation) },
      system: SYSTEM,
      messages: [{ role: 'user', content: `${facts}\n\nInstruction: ${text}` }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) console.error(JSON.stringify({ llm: 'bad or missing API key; falling back to the regex parser' }));
    else if (e instanceof Anthropic.RateLimitError) console.error(JSON.stringify({ llm: 'rate limited; falling back' }));
    else if (e instanceof Anthropic.APIError) console.error(JSON.stringify({ llm: `API error ${e.status}`, msg: e.message }));
    else console.error(JSON.stringify({ llm: 'call failed', msg: String(e?.message || e) }));
    return null;
  }

  if (res.stop_reason === 'refusal') return { action: 'reject', reply: "I can't help with that instruction." };
  const out = res.parsed_output;
  if (!out) return null;
  if (out.action !== 'rule') return { action: out.action, reply: out.reply };

  // Never trust the model's rule as-is: same checks as the regex path.
  const r = out.rule || {};
  const checked = validateRule({ ...r, every: r.every_seconds ?? undefined }, ctx.symbols);
  if (checked.error) return { action: 'reject', reply: out.reply, error: checked.error };
  return { action: 'rule', rule: checked.rule, reply: out.reply };
}
