export const metadata = { title: "WFUMC Sermons connector", robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#f8f5ef" }}>{children}</body>
    </html>
  );
}
