// skills/cassie/install.d.ts

export interface InstallCassieSkillOptions {
  force?: boolean;
  quiet?: boolean;
  roots?: string[];
}

export declare function installCassieSkill(options?: InstallCassieSkillOptions): string[];
