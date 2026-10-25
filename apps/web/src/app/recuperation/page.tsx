import type { Metadata } from 'next';
import { RecoveryScreen } from '../../components/recovery-screen.tsx';
export const metadata: Metadata = {
  title: 'Récupérer votre accès — Memoria',
  referrer: 'no-referrer',
};
export default function RecoveryPage() {
  return <RecoveryScreen />;
}
