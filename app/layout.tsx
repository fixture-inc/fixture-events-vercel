import type { ReactNode } from 'react';
import './style.css';

export const metadata = {
  title: 'Fixture events · Consumer demo',
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
