import path from 'node:path';

/**
 * 预设岗位（lib/store.mjs 的 PRESET_ROLES）会按名字引用技能。
 * 这些技能分两类：
 *   1. 项目自带的：放在仓库 skills/ 目录，随安装包分发，离线可用；
 *   2. 第三方的：只登记公开源仓库，在 Skills 管理界面里一键安装，不随包分发。
 * 之前的做法是角色里写了技能名，但仓库和安装包都没带任何技能文件，
 * 别人下载后职位看着「自带了技能」，打开技能管理却一个都没有 —— 空壳。
 */

export const BUNDLED_SKILLS_DIR = path.resolve(import.meta.dirname, '..', 'skills');

// 第三方技能的公开来源。repo 留空的表示没有可靠的公开源，只能提示用户手动导入。
export const SKILL_SOURCES = {
  'agent-reach': {
    repo: 'https://github.com/Panniantong/Agent-Reach/tree/main/agent_reach/skill',
    label: 'Agent Reach（只读内容抓取）',
  },
  'baoyu-article-illustrator': {
    repo: 'https://github.com/JimLiu/baoyu-skills/tree/main/skills/baoyu-article-illustrator',
    label: 'baoyu-skills',
  },
  'baoyu-cover-image': {
    repo: 'https://github.com/JimLiu/baoyu-skills/tree/main/skills/baoyu-cover-image',
    label: 'baoyu-skills',
  },
  'baoyu-diagram': {
    repo: 'https://github.com/JimLiu/baoyu-skills/tree/main/skills/baoyu-diagram',
    label: 'baoyu-skills',
  },
  'baoyu-format-markdown': {
    repo: 'https://github.com/JimLiu/baoyu-skills/tree/main/skills/baoyu-format-markdown',
    label: 'baoyu-skills',
  },
  'baoyu-infographic': {
    repo: 'https://github.com/JimLiu/baoyu-skills/tree/main/skills/baoyu-infographic',
    label: 'baoyu-skills',
  },
  'baoyu-xhs-images': {
    repo: 'https://github.com/JimLiu/baoyu-skills/tree/main/skills/baoyu-xhs-images',
    label: 'baoyu-skills',
  },
  'ui-ux-pro-max': {
    repo: '',
    label: 'UI/UX 设计知识库',
    hint: '没有公开源仓库，需要手动把技能目录放进 ~/.agents/skills/ui-ux-pro-max。',
  },
  'huangbai-video-edit': {
    repo: '',
    label: '视频剪辑技能包',
    hint: '第三方付费技能包，需手动导入技能目录。',
  },
  'huangbai-video-prompt': {
    repo: '',
    label: '视频提示词技能包',
    hint: '第三方付费技能包，需手动导入技能目录。',
  },
  'huangbai-motion-graphics': {
    repo: '',
    label: '动态视觉技能包',
    hint: '第三方付费技能包，需手动导入技能目录。',
  },
  'huangbai-multicam-prompt': {
    repo: '',
    label: '多机位技能包',
    hint: '第三方付费技能包，需手动导入技能目录。',
  },
  'reverse-engineer-anything': {
    repo: '',
    label: 'REA 逆向工程',
    hint: '通过 npm 包 rea-agents 分发，执行 `npx -y rea-agents@latest` 安装后再导入技能目录。',
  },
};

export function skillSourceOf(name) {
  return SKILL_SOURCES[String(name || '')] || null;
}

/** 哪些第三方技能可以一键安装（有公开源） */
export function isInstallable(name) {
  return !!skillSourceOf(name)?.repo;
}
