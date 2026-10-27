import { useNavigate } from "react-router-dom";
import { CreatePlanForm } from "@/components/portal/CreatePlanForm";
import { EnrolmentGate, useEnrolmentRequired } from "@/components/portal/EnrolmentGate";
import { PageHeader } from "@/components/portal/PageHeader";
import { Section } from "@/components/portal/primitives";

export function PlansNewPage() {
  const navigate = useNavigate();
  const enrolmentRequired = useEnrolmentRequired();
  return (
    <>
      <PageHeader kicker="Catalogue" title="Create a plan" onBack={() => navigate("/plans")} />
      {/*
        The gate replaces the form rather than sitting above it. A disabled
        form still reads as something to fill in, and the merchant who filled
        one in was the person this change is for: they lost a plan's worth of
        typing to a rule the page had never mentioned.

        `null` is still loading — render neither, so an enrolled merchant does
        not see the prompt flash before their form.
      */}
      {enrolmentRequired === null ? null : enrolmentRequired ? (
        <EnrolmentGate action="creating a plan" />
      ) : (
        <Section bordered={false}>
          <div className="max-w-4xl">
            <CreatePlanForm />
          </div>
        </Section>
      )}
    </>
  );
}
