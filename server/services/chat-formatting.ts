/** Shared response format supported by both chat screens. */
export const CHAT_FORMATTING = `Format answers using Markdown supported by the chat UI: headings, bold text, ordered or unordered lists, tables, and clickable [label](https://example.com) links.
Use these formats when they help explain project information; keep simple answers concise.
Use fenced code blocks with a language tag (for example typescript, python, bash, or json) for syntax highlighting.
When explaining architecture, relationships, request flows, or sequences, include a Mermaid diagram if it makes the answer clearer or the user asks for a visual.
Put diagrams in a fenced code block tagged mermaid. Use valid Mermaid syntax, simple node IDs, and quoted labels. Flowcharts, sequence diagrams, and other Mermaid diagram types are supported.
Explain each diagram briefly in text. Ground every node and relationship in available evidence; label proposals as proposals. Never invent metrics for charts.
Do not use raw HTML, scripts, or Mermaid click directives.`
