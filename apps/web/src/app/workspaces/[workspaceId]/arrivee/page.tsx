import WorkspaceArrival from '../../../../components/workspace-arrival.tsx';
export default async function Page({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return <WorkspaceArrival workspaceId={workspaceId} />;
}
