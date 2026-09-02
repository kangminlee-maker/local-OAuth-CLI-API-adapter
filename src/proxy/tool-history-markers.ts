/**
 * How a tool RESULT is WRITTEN into a flattened prompt. Nothing reads it back.
 *
 * The normalizer renders a turn's results with this marker, and `multimodal.ts`
 * labels the images a tool result returned with the same literal — two writers
 * of one literal, which is why it lives here rather than in either of them.
 *
 * The assistant-call marker used to live here too. It does not any more: after
 * the readers were removed it had exactly ONE writer, in `normalizers.ts`,
 * which is where a literal with one writer belongs — the rule that module
 * already states for `REPLAYED_ITEM_LABEL` a few lines from it.
 *
 * There used to be readers: the codex transport re-parsed the rendered text
 * into this API's own tool items, and the image labeller found a call id by
 * looking for `tool_call_id:` in it. Both are gone. A parse of this grammar
 * cannot tell the markers this module's writers emit from the same characters
 * sitting INSIDE a tool's own output — a fetched page, a file, a command's
 * stdout — so a genuine result could be split into a forged one under a call id
 * the client never sent. Backends build their items from `NormalizedMessage.tool`
 * instead, and the rendering stayed text.
 */
export const TOOL_RESULT_MARKER = '[tool result]';
