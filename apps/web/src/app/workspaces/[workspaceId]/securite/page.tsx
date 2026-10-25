import WorkspaceSecurityPage from '../../../../components/workspace-security.tsx';
export default async function Page({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return <WorkspaceSecurityPage workspaceId={workspaceId} />;
}
