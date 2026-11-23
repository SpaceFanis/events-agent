import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const HAIKU = "claude-haiku-5-5";
export const SONNET = "claude-sonnet-5-5";
export type LlmModel = typeof HAIKU | typeof SONNET;

/** USD per million tokens. Haiku's higher tier applies to prompts over 100k tokens. */
const PRICES: Record<
  LlmModel,
  { input: number; output: number; longInput?: number; longOutput?: number }
> = {
  [HAIKU]: { input: 0.1, output: 0.5, longInput: 0.5, longOutput: 2.5 },
  [SONNET]: { input: 2, output: 10 },
};
const LONG_PROMPT_TOKENS = 100_000;

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export function costUsd(model: LlmModel, usage: LlmUsage): number {
  const price = PRICES[model];
  const long = usage.inputTokens > LONG_PROMPT_TOKENS;
  const input = long ? (price.longInput ?? price.input) : price.input;
  const output = long ? (price.longOutput ?? price.output) : price.output;
  return (usage.inputTokens * input + usage.outputTokens * output) / 1_000_000;
}

/** Upper bound for one call, checked against the caps before the call is made. */
export function worstCaseCostUsd(model: LlmModel, promptChars: number, maxTokens: number): number {
  // One token per character: an upper bound even for Greek and other non-Latin pages.
  return costUsd(model, { inputTokens: promptChars, outputTokens: maxTokens });
}

export interface LlmRequest {
  model: LlmModel;
  /** Page the request is about; replay mode looks responses up by model + url. */
  url: string;
  system: string;
  prompt: string;
  /** Structured output schema the response must follow. */
  schema: z.ZodType;
  maxTokens: number;
  effort: "low" | "medium";
}

export interface LlmResponse {
  /** The model's JSON text, or null when it produced none (e.g. a refusal). */
  text: string | null;
  stopReason: string | null;
  usage: LlmUsage;
}

/**
 * - `request`: this request was rejected (e.g. 400); counts against the page, retrying it won't help.
 * - `systemic`: outage, auth, rate limit; stop LLM work for this run and retry next run.
 */
export class LlmError extends Error {
  override name = "LlmError";
  constructor(
    message: string,
    readonly failure: "request" | "systemic",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** The Anthropic API, behind an interface so replay mode and tests use recorded responses. */
export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export class AnthropicLlm implements LlmClient {
  constructor(private readonly client: Anthropic) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
        output_config: { effort: request.effort, format: zodOutputFormat(request.schema) },
      });
    } catch (error) {
      // The SDK has already retried 408/409/429/5xx and connection errors by now.
      if (error instanceof Anthropic.BadRequestError) {
        throw new LlmError(`anthropic: ${error.message}`, "request", { cause: error });
      }
      const detail = error instanceof Anthropic.APIError ? error.message : "request failed";
      throw new LlmError(`anthropic: ${detail}`, "systemic", { cause: error });
    }
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return {
      text: text === "" ? null : text,
      stopReason: message.stop_reason,
      usage: {
        inputTokens:
          message.usage.input_tokens +
          (message.usage.cache_creation_input_tokens ?? 0) +
          (message.usage.cache_read_input_tokens ?? 0),
        outputTokens: message.usage.output_tokens,
      },
    };
  }
}

const recordedResponse = z.strictObject({
  stop_reason: z.string(),
  usage: z.strictObject({ input_tokens: z.number(), output_tokens: z.number() }),
  /** The structured output; omitted for refusals. */
  output: z.unknown().optional(),
});

/**
 * Serves recorded responses from `<dir>/llm.json`, a map of "<model> <url>" → fixture file.
 * A request without a recording fails, so replay never reaches the API.
 */
export class ReplayLlm implements LlmClient {
  private manifest: Record<string, string> | undefined;
  readonly requests: LlmRequest[] = [];

  constructor(private readonly dir: string) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    this.manifest ??= z
      .record(z.string(), z.string())
      .parse(JSON.parse(await readFile(join(this.dir, "llm.json"), "utf8")));
    const file = this.manifest[`${request.model} ${request.url}`];
    if (file === undefined) {
      throw new LlmError(
        `replay: no LLM response recorded for ${request.model} ${request.url}`,
        "systemic",
      );
    }
    const recorded = recordedResponse.parse(
      JSON.parse(await readFile(join(this.dir, file), "utf8")),
    );
    return {
      text: recorded.output === undefined ? null : JSON.stringify(recorded.output),
      stopReason: recorded.stop_reason,
      usage: {
        inputTokens: recorded.usage.input_tokens,
        outputTokens: recorded.usage.output_tokens,
      },
    };
  }
}
