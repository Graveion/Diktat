// Strip markdown for TTS — speech engines stumble over symbols like # * ` etc.
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "code block") // fenced code → placeholder
    .replace(/`[^`]+`/g, "")                    // inline code → drop
    .replace(/^#{1,6}\s+/gm, "")                // headings
    .replace(/\*\*([^*]+)\*\*/g, "$1")          // bold
    .replace(/\*([^*]+)\*/g, "$1")              // italic
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")       // images → drop (before links, so the ! isn't orphaned)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")    // links → text only
    .replace(/^[\s-]*[-*+]\s+/gm, ". ")         // bullets → pause
    .replace(/\n{2,}/g, ". ")                   // paragraphs → period
    .replace(/\n/g, " ")
    .trim();
}
