import type { Metadata } from 'next';
import InvitationScreen from '../../components/invitation-screen.tsx';
export const metadata: Metadata = { title: 'Invitation — Memoria', referrer: 'no-referrer' };
export default function Page() {
  return <InvitationScreen />;
}
