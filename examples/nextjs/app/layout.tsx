import type { ReactNode } from "react";

export const metadata = {
  title: "Brass Next.js example",
  description: "Brass runtime with Next.js App Router",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

