import { CreatePlanForm } from "@/components/portal/CreatePlanForm";

export function PlansNewPage() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Create Plan</h1>
      <div className="card max-w-4xl p-6">
        <CreatePlanForm />
      </div>
    </div>
  );
}
