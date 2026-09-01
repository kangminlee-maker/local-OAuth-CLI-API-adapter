/**
 * How a tool turn is WRITTEN into a flattened prompt. Nothing reads it back.
 *
 * The normalizer renders a turn's calls and results with these markers, and
 * `multimodal.ts` labels the images a tool result returned with the same
 * `[tool result]` literal — two writers of one literal, which is why it lives
 * here rather than in either of them.
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
export const ASSISTANT_TOOL_CALL_MARKER = '[assistant tool_call]';
export const TOOL_RESULT_MARKER = '[tool result]';
