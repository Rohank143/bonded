import type { IAgentRuntime, Project, ProjectAgent } from "@elizaos/core";
import { character } from "./character";
import { tradingPlugin } from "./plugin";

export const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => {
    console.log(`Starting ${runtime.character.name}`);
  },
  plugins: [tradingPlugin],
};

const project: Project = { agents: [projectAgent] };
export default project;
