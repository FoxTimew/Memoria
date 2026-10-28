import DatabaseScreen from '../../../../../components/database-screen.tsx';
export default async function DatabasePage({
  params,
}: {
  params: Promise<{ workspaceId: string; databaseId: string }>;
}) {
  return <DatabaseScreen {...await params} />;
}
