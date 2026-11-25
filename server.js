import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// Parse JSON request bodies
app.use(express.json({ limit: "1mb" }));

// Helper to initialize the server-side Gemini client
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// Helper for exponential backoff retries on transient Gemini errors
async function generateWithRetry(ai, params, maxRetries = 2) {
  let attempt = 0;
  while (true) {
    try {
      return await ai.models.generateContent(params);
    } catch (error) {
      const status = error?.status || error?.code;
      const isTransient = status === 429 || status === 503 || status === 500;
      if (!isTransient || attempt >= maxRetries) {
        throw error;
      }
      const delayMs = 600 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }
}

// Helper to call OpenAI when OPENAI_API_KEY is configured in Settings > Secrets
async function callOpenAI(messages, webSearch) {
  const openAiKey = process.env.OPENAI_API_KEY;
  if (!openAiKey) {
    return null;
  }

  // Use OpenAI Responses API when webSearch is enabled to retrieve live citations
  if (webSearch) {
    const systemMsgs = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const convoMsgs = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openAiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        instructions: systemMsgs || undefined,
        input: convoMsgs,
        tools: [{ type: "web_search_preview" }],
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      let replyText = data.output_text || "";
      const seenUris = new Set();
      const sources = [];

      for (const item of data.output || []) {
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === "output_text") {
              if (!replyText && part.text) {
                replyText = part.text;
              }
              for (const ann of part.annotations || []) {
                if (ann.type === "url_citation" && ann.url && !seenUris.has(ann.url)) {
                  seenUris.add(ann.url);
                  sources.push({
                    title: ann.title || ann.url,
                    uri: ann.url,
                  });
                }
              }
            }
          }
        }
      }

      return { replyText: replyText.trim(), sources };
    }
  }

  // Standard OpenAI Chat Completions API using gpt-4.1
  const chatResp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openAiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages,
    }),
  });

  const chatData = await chatResp.json();
  if (!chatResp.ok) {
    const err = new Error(
      chatData?.error?.message || "OpenAI API request failed."
    );
    err.status = chatResp.status;
    throw err;
  }

  return {
    replyText: (chatData?.choices?.[0]?.message?.content || "").trim(),
    sources: [],
  };
}

// POST /api/chat — Proxy endpoint matching the Cloudflare Worker messages[] contract
app.post("/api/chat", async (req, res) => {
  const { messages, webSearch = true } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: "Request body must include a non-empty messages array.",
    });
  }

  try {
    // 1. If OPENAI_API_KEY is configured in Settings > Secrets, use OpenAI
    if (process.env.OPENAI_API_KEY) {
      const result = await callOpenAI(messages, webSearch);
      return res.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: result.replyText,
            },
          },
        ],
        sources: result.sources,
      });
    }

    // 2. Otherwise use GEMINI_API_KEY with @google/genai and Google Search grounding
    const ai = getGeminiClient();
    if (!ai) {
      return res.status(500).json({
        error:
          "Server API key is not configured. Please add GEMINI_API_KEY or OPENAI_API_KEY in Settings > Secrets.",
      });
    }

    const systemParts = [];
    const contents = [];

    for (const msg of messages) {
      if (!msg || typeof msg.content !== "string") continue;
      if (msg.role === "system") {
        systemParts.push(msg.content.trim());
      } else {
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }],
        });
      }
    }

    if (contents.length === 0) {
      return res.status(400).json({
        error: "Messages must contain at least one user prompt.",
      });
    }

    const config = {};
    if (systemParts.length > 0) {
      config.systemInstruction = systemParts.join("\n\n");
    }
    if (webSearch) {
      config.tools = [{ googleSearch: {} }];
    }

    const response = await generateWithRetry(ai, {
      model: "gemini-4-hydrogen",
      contents,
      config,
    });

    const replyText = (response.text || "").trim();

    // Extract deduplicated web search grounding links for citation display
    const chunks =
      response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const seenUris = new Set();
    const sources = [];

    for (const chunk of chunks) {
      const uri = chunk?.web?.uri;
      if (uri && !seenUris.has(uri)) {
        seenUris.add(uri);
        sources.push({
          title: chunk.web.title || uri,
          uri,
        });
      }
    }

    return res.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: replyText,
          },
        },
      ],
      sources,
    });
  } catch (error) {
    console.error("Error generating routine/chat response:", error);
    const statusCode =
      typeof error?.status === "number" && error.status >= 400
        ? error.status
        : 500;
    return res.status(statusCode).json({
      error:
        error?.message ||
        "Unable to generate a response right now. Please try again.",
    });
  }
});

// Serve static files from the repository root
app.use(express.static(__dirname));

// Fallback to index.html for unknown GET routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
