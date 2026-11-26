import Anthropic from "@anthropic-ai/sdk";
import { runTool, tools } from "./tools";

// Reads ANTHROPIC_API_KEY (or an `ant auth login` profile) from the environment.
const client = new Anthropic();

const MODEL = "claude-sonnet-5";
const MAX_STEPS = 10;
const MAX_SESSIONS = 1000;

const SYSTEM_PROMPT = `You are a friendly, concise weather reporter.

- Use the tools to get live data. Never guess or invent weather values.
- Use get_current_weather for "now" questions and get_forecast for anything about today's range, tomorrow, the weekend, or later. Day 1 of a forecast is today in the location's local time.
- Default to metric units unless the user asks for Fahrenheit/imperial or is clearly in the US.
- If the user hasn't said which city, ask for it.
- If a tool returns an error (e.g. the city wasn't found), explain briefly and suggest a fix, such as adding the country.
- For "when should I…" or "best time to…" questions (a run, laundry, a walk, a commute), use get_hourly_forecast and recommend a specific time window with the reason (e.g. "7–9 AM: dry, 18°C, low UV"). Prefer daylight hours unless the user says otherwise.
- For health or outdoor-safety questions (air quality, pollution, asthma, kids or elderly outside, UV, pollen), use get_air_quality. Report the AQI and its category, and give practical advice, with extra care for sensitive groups. Don't be alarmist and don't give medical diagnoses.
- For outdoor exercise or activity planning, call get_hourly_forecast and get_air_quality together and weigh both weather and air quality when picking a time.
- When comparing several cities, fetch them all at once.
- Lead with the answer (e.g. "Yes, bring an umbrella"), then the key numbers. Use short markdown bullet lists for multi-day forecasts. Mention the resolved location so the user can tell if the wrong city was matched.
- You only answer about weather, forecast and air quality. For anything else unrelated to weather (like travel, planning, general chat), briefly say It's outside your scope and offer a weather related query.
- You may use weather to help trip timings but don't recommand attraction, hotels or itineraries `;

export class AgentBusyError extends Error {}

// In-memory conversation history per session. Use Redis/a database if you need persistence or multiple server instances.
const sessions = new Map<string, Anthropic.MessageParam[]>();
const busy = new Set<string>();

function getHistory(sessionId: string): Anthropic.MessageParam[] {
    let history = sessions.get(sessionId);
    if (!history) {
        if (sessions.size >= MAX_SESSIONS) {
            // Evict the oldest session (Map preserves insertion order).
            sessions.delete(sessions.keys().next().value!);
        }
        history = [];
        sessions.set(sessionId, history);
    }
    return history;
}

export function resetSession(sessionId: string) {
    sessions.delete(sessionId);
}

// Read-only access to a session's history (used by evals to inspect tool calls and results).
export const getSessionHistory = (sessionId: string) => sessions.get(sessionId);

async function executeToolCall(block: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
    try {
        const content = await runTool(block.name, block.input);
        return { type: "tool_result", tool_use_id: block.id, content };
    } catch (err) {
        // Report failures back to the model so it can recover instead of crashing the loop.
        const message = err instanceof Error ? err.message : String(err);
        return { type: "tool_result", tool_use_id: block.id, content: message, is_error: true };
    }
}

function textOf(message: Anthropic.Message): string {
    return message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
}

export async function runAgent(sessionId: string, userMessage: string): Promise<string> {
    debugger;
    if (busy.has(sessionId)) throw new AgentBusyError("A request for this session is already in progress.");
    busy.add(sessionId);

    const history = getHistory(sessionId);
    const checkpoint = history.length;

    try {
        history.push({ role: "user", content: userMessage });

        for (let step = 0; step < MAX_STEPS; step++) {
            const res = await client.messages.create({
                model: MODEL,
                max_tokens: 16000,
                system: SYSTEM_PROMPT,
                tools,
                messages: history,
            });
            history.push({ role: "assistant", content: res.content });

            switch (res.stop_reason) {
                case "tool_use": {
                    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
                    // Run parallel tool calls concurrently and return all results in a single user message.
                    const results = await Promise.all(calls.map(executeToolCall));
                    history.push({ role: "user", content: results });
                    continue;
                }
                case "refusal": {
                    // Drop the refused turn so it doesn't pollute later turns.
                    history.length = checkpoint;
                    return "Sorry, I can't help with that request. I can tell you about the weather anywhere in the world, though!";
                }
                case "max_tokens":
                    return (textOf(res) + "\n\n_(Response was cut off.)_").trim();
                default:
                    return textOf(res) || "I don't have an answer for that. Could you rephrase?";
            }
        }

        throw new Error(`Agent did not finish within ${MAX_STEPS} steps.`);
    } catch (err) {
        // Roll back this turn so history never ends with an unanswered tool_use or dangling user message.
        history.length = checkpoint;
        throw err;
    } finally {
        busy.delete(sessionId);
    }
}
