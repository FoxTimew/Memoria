import WorkspacePages from '../../../components/workspace-pages.tsx';
export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <WorkspacePages workspaceId={workspaceId} />;
}
