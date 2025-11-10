export const metadata = {
  title: "Legacy Cache Test",
  description: "Testing fetch caching without cacheComponents",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
