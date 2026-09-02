import { useNavigate } from "react-router-dom";
import { CreatePlanForm } from "@/components/portal/CreatePlanForm";
import { PageHeader } from "@/components/portal/PageHeader";
import { Section } from "@/components/portal/primitives";

export function PlansNewPage() {
  const navigate = useNavigate();
  return (
    <>
      <PageHeader kicker="Catalogue" title="Create a plan" onBack={() => navigate("/plans")} />
      <Section bordered={false}>
        <div className="max-w-4xl">
          <CreatePlanForm />
        </div>
      </Section>
    </>
  );
}
