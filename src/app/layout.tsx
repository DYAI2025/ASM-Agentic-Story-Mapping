import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ASM – Agentic Story Mapping",
  description: "Narrative-first story map over a canonical product file.",
};

/**
 * Runs before the first paint. A viewer who hid the guide (a browser
 * preference, see StoryMapEditor) does not see it flash while the page loads.
 */
const GUIDE_PREFERENCE_SCRIPT =
  "try{if(localStorage.getItem('asm.guide')==='off')document.documentElement.dataset.guide='off'}catch(e){}";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: GUIDE_PREFERENCE_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
