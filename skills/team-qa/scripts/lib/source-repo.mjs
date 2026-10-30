// Where the skills' sources live (public v1). A built skill's SOURCE.json names this repository, and every check
// of where an installed skill came from compares against it.
export const SOURCE_OWNER = 'agentpro-tech';
export const sourceRepoUrl = (skill) => `https://github.com/${SOURCE_OWNER}/${skill}.git`;
