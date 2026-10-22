import { Suspense } from 'react';
import { AuthScreen } from '../../components/auth-screen.tsx';
export default function Page() {
  return (
    <Suspense fallback={<p className="p-8">Chargement…</p>}>
      <AuthScreen mode="signup" />
    </Suspense>
  );
}
