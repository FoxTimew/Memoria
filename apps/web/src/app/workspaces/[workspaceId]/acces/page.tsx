import WorkspaceAccess from '../../../../components/workspace-access.tsx';
export default async function Page({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return <WorkspaceAccess workspaceId={workspaceId} />;
}
