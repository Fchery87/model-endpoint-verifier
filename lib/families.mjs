// Provider-family mapping and capability heuristics.
// Kept dependency-free so tests and CI drift checks can import it without
// starting the HTTP server. Family mapping is a claim check on self-reported
// IDs, not proof of provider identity.

export function familyFromModel(modelId) {
  const id = String(modelId || "").toLowerCase();
  if (/(claude|anthropic|fable|mythos)/.test(id)) return "Anthropic";
  if (/(gpt|o[134](?:-|$)|openai)/.test(id)) return "OpenAI";
  if (/(gemini|gemma|google)/.test(id)) return "Google";
  if (/deepseek/.test(id)) return "DeepSeek";
  if (/(llama|\bmeta\b)/.test(id)) return "Meta";
  if (/(mistral|mixtral|pixtral)/.test(id)) return "Mistral";
  if (/(grok|xai)/.test(id)) return "xAI";
  if (/(qwen|alibaba)/.test(id)) return "Alibaba";
  if (/(command|cohere)/.test(id)) return "Cohere";
  if (/(kimi|moonshot)/.test(id)) return "Moonshot";
  if (/(glm|zhipu|z\.ai)/.test(id)) return "Z.ai";
  if (/mimo/.test(id)) return "Xiaomi";
  if (/minimax/.test(id)) return "MiniMax";
  if (/(nemotron|nvidia)/.test(id)) return "NVIDIA";
  return "Unknown family";
}

export function familyFromHeaders(safeHeaders) {
  const entries = typeof safeHeaders?.entries === "function"
    ? [...safeHeaders.entries()]
    : Object.entries(safeHeaders || {});
  const names = entries.map(([name]) => String(name).toLowerCase());
  const identityValues = entries
    .filter(([name]) => ["server", "via", "x-served-by"].includes(String(name).toLowerCase()))
    .map(([, value]) => String(value).toLowerCase());
  const families = new Set();
  if (names.some((name) => name.startsWith("anthropic-")) || identityValues.some((value) => value.includes("anthropic"))) {
    families.add("Anthropic");
  }
  if (names.some((name) => name.startsWith("openai-")) || identityValues.some((value) => value.includes("openai"))) {
    families.add("OpenAI");
  }
  if (names.includes("x-goog-request-id") || identityValues.some((value) => value.includes("google"))) {
    families.add("Google");
  }
  if (identityValues.some((value) => value.includes("deepseek"))) {
    families.add("DeepSeek");
  }
  if (identityValues.some((value) => value.includes("xai") || value.includes("grok"))) {
    families.add("xAI");
  }
  if (families.size > 1) return "Mixed";
  return families.values().next().value || "Unknown family";
}

export function advertisedCapabilities(modelId) {
  const id = String(modelId || "").toLowerCase();
  const nonChat = /(embedding|moderation|rerank|whisper|tts|image|realtime|transcribe|speech|audio|live)/.test(id);
  return {
    likelyTools: !nonChat,
    likelyChat: !nonChat,
  };
}
