import DatabaseScreen from '../../../../../../../components/database-screen.tsx';
export default async function DatabaseRowPage({
  params,
}: {
  params: Promise<{ workspaceId: string; databaseId: string; rowId: string }>;
}) {
  return <DatabaseScreen {...await params} />;
}
