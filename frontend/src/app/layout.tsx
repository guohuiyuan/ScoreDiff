import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ScoreDiff",
  description: "智能练琴 Diff 工具",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="h-full">{children}</body>
    </html>
  );
}
