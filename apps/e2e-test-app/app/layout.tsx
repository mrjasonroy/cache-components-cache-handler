import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cache Handler E2E Tests",
  description: "Testing Next.js 16 cache components",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
