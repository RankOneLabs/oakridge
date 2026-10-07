import type { Prompt } from "../source-contracts";

export const prompts: Prompt[] = [
  {
    key: "spec_analysis_author_initial",
    path: "workflow-config/prompts/dev-flow/spec_analysis_author_initial.md",
    input_schema: "session_action",
    content_digest: "000d4ce14d29be748b3ee4de65fa22448535f7a23250e65e228acf61f8585aa3"
  },
  {
    key: "spec_analysis_author_revise",
    path: "workflow-config/prompts/dev-flow/spec_analysis_author_revise.md",
    input_schema: "session_action",
    content_digest: "000d4ce14d29be748b3ee4de65fa22448535f7a23250e65e228acf61f8585aa3"
  },
  {
    key: "spec_analysis_author_retry",
    path: "workflow-config/prompts/dev-flow/spec_analysis_author_retry.md",
    input_schema: "session_action",
    content_digest: "000d4ce14d29be748b3ee4de65fa22448535f7a23250e65e228acf61f8585aa3"
  },
  {
    key: "planning_author_initial",
    path: "workflow-config/prompts/dev-flow/planning_author_initial.md",
    input_schema: "session_action",
    content_digest: "3c64ff0386aada30d98a22243f2d66e33934762b3d612881a081b8325d5c25e3"
  },
  {
    key: "planning_author_revise",
    path: "workflow-config/prompts/dev-flow/planning_author_revise.md",
    input_schema: "session_action",
    content_digest: "3c64ff0386aada30d98a22243f2d66e33934762b3d612881a081b8325d5c25e3"
  },
  {
    key: "planning_author_retry",
    path: "workflow-config/prompts/dev-flow/planning_author_retry.md",
    input_schema: "session_action",
    content_digest: "3c64ff0386aada30d98a22243f2d66e33934762b3d612881a081b8325d5c25e3"
  },
  {
    key: "brief_writing_author_initial",
    path: "workflow-config/prompts/dev-flow/brief_writing_author_initial.md",
    input_schema: "session_action",
    content_digest: "81472b06de2ce081dbebf7676366438d1caf4c11bca8e93811d9c426b5e953b8"
  },
  {
    key: "brief_writing_author_revise",
    path: "workflow-config/prompts/dev-flow/brief_writing_author_revise.md",
    input_schema: "session_action",
    content_digest: "81472b06de2ce081dbebf7676366438d1caf4c11bca8e93811d9c426b5e953b8"
  },
  {
    key: "brief_writing_author_retry",
    path: "workflow-config/prompts/dev-flow/brief_writing_author_retry.md",
    input_schema: "session_action",
    content_digest: "81472b06de2ce081dbebf7676366438d1caf4c11bca8e93811d9c426b5e953b8"
  },
  {
    key: "implementation_build_initial",
    path: "workflow-config/prompts/dev-flow/implementation_build_initial.md",
    input_schema: "session_action",
    content_digest: "046070608268f3d0e35219e7039efd707b26ee230e59fc1d974976a310d44f4d"
  },
  {
    key: "implementation_build_revise",
    path: "workflow-config/prompts/dev-flow/implementation_build_revise.md",
    input_schema: "session_action",
    content_digest: "046070608268f3d0e35219e7039efd707b26ee230e59fc1d974976a310d44f4d"
  },
  {
    key: "implementation_build_replace_pr",
    path: "workflow-config/prompts/dev-flow/implementation_build_replace_pr.md",
    input_schema: "session_action",
    content_digest: "046070608268f3d0e35219e7039efd707b26ee230e59fc1d974976a310d44f4d"
  },
  {
    key: "implementation_build_retry",
    path: "workflow-config/prompts/dev-flow/implementation_build_retry.md",
    input_schema: "session_action",
    content_digest: "046070608268f3d0e35219e7039efd707b26ee230e59fc1d974976a310d44f4d"
  },
  {
    key: "implementation_build_retry_missing_build",
    path: "workflow-config/prompts/dev-flow/implementation_build_retry_missing_build.md",
    input_schema: "session_action",
    content_digest: "046070608268f3d0e35219e7039efd707b26ee230e59fc1d974976a310d44f4d"
  },
  {
    key: "implementation_build_retry_missing_pr",
    path: "workflow-config/prompts/dev-flow/implementation_build_retry_missing_pr.md",
    input_schema: "session_action",
    content_digest: "046070608268f3d0e35219e7039efd707b26ee230e59fc1d974976a310d44f4d"
  },
  {
    key: "implementation_assessment_initial",
    path: "workflow-config/prompts/dev-flow/implementation_assessment_initial.md",
    input_schema: "session_action",
    content_digest: "1eedf6fed0596bda856079312bb54c00d55b711d11a224e9d7346053df026e4d"
  },
  {
    key: "implementation_assessment_retry",
    path: "workflow-config/prompts/dev-flow/implementation_assessment_retry.md",
    input_schema: "session_action",
    content_digest: "1eedf6fed0596bda856079312bb54c00d55b711d11a224e9d7346053df026e4d"
  },
  {
    key: "implementation_assessment_discuss",
    path: "workflow-config/prompts/dev-flow/implementation_assessment_discuss.md",
    input_schema: "session_action",
    content_digest: "1eedf6fed0596bda856079312bb54c00d55b711d11a224e9d7346053df026e4d"
  },
  {
    key: "implementation_build_revise_after_assessment",
    path: "workflow-config/prompts/dev-flow/implementation_build_revise_after_assessment.md",
    input_schema: "session_action",
    content_digest: "046070608268f3d0e35219e7039efd707b26ee230e59fc1d974976a310d44f4d"
  },
  {
    key: "final_integration_integrator_initial",
    path: "workflow-config/prompts/dev-flow/final_integration_integrator_initial.md",
    input_schema: "session_action",
    content_digest: "3ed66e609965916aadd144a23078a01debf7da4c48eab6364786d4631c902939"
  },
  {
    key: "final_integration_integrator_retry",
    path: "workflow-config/prompts/dev-flow/final_integration_integrator_retry.md",
    input_schema: "session_action",
    content_digest: "3ed66e609965916aadd144a23078a01debf7da4c48eab6364786d4631c902939"
  }
];
