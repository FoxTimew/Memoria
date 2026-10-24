import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { LocalDataBoundary } from '../components/local-data-boundary.tsx';

export const metadata: Metadata = {
  title: 'Memoria — Votre espace de travail',
  description: 'Un espace pour les idées et les projets de votre studio.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-screen antialiased">
        <LocalDataBoundary>{children}</LocalDataBoundary>
      </body>
    </html>
  );
}
