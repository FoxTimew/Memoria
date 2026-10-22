import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Memoria — Votre espace de travail',
  description: 'Un espace pour les idées et les projets de votre studio.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
