import { ArtifactReview } from "../components/organisms/ArtifactReview";

interface ArtifactReviewViewProps {
  artifactId: string;
  onBack: () => void;
}

export function ArtifactReviewView(props: ArtifactReviewViewProps) {
  return <ArtifactReview {...props} />;
}
