import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

const SYSTEM_PROMPT = `You are an expert full-stack developer. The user will describe an app or feature they want built.

You MUST respond with ONLY code files in the following exact format. No explanations before or after the files.

For each file, use this exact delimiter format:
===FILE: path/to/file.tsx===
(file content here)
===END_FILE===

Rules:
- Use React with TypeScript and Tailwind CSS for styling
- The main entry point MUST be "src/app/page.tsx" with a default export
- Use modern, clean, responsive design with Tailwind utility classes
- Use className (React) not class
- Make it visually impressive with gradients, shadows, proper spacing
- Include ALL necessary files (page.tsx, components, globals.css)
- CSS file should be "src/app/globals.css"
- Do NOT use any import statements for external packages (no next/image, no next/link etc.)
- Do NOT use React hooks like useState or useEffect - keep components as pure render functions
- Export components as default functions
- Make the page fully self-contained and renderable as static HTML with Tailwind
- Do NOT include any explanation text outside of ===FILE: ... === blocks`;

export async function POST(req: NextRequest) {
  const { prompt, existingFiles } = await req.json();

  if (!prompt || typeof prompt !== "string") {
    return new Response(JSON.stringify({ error: "prompt is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error:
          "ANTHROPIC_API_KEY not configured. Add it to frontend/.env.local",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const client = new Anthropic({ apiKey });

  // Build context from existing files
  let context = "";
  if (existingFiles && Array.isArray(existingFiles)) {
    const fileDescriptions = existingFiles
      .filter((f: { content?: string }) => f.content)
      .map((f: { path: string; content: string }) => `--- ${f.path} ---\n${f.content}`)
      .join("\n\n");
    if (fileDescriptions) {
      context = `\n\nHere are the existing project files for context:\n${fileDescriptions}\n\nModify or add files as needed based on the user's request.`;
    }
  }

  // Stream the response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const response = await client.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: prompt + context,
            },
          ],
          stream: true,
        });

        for await (const event of response) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            // Send as SSE
            const data = JSON.stringify({ type: "text", content: event.delta.text });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }
        }

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "error", error: message })}\n\n`
          )
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
