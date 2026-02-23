export interface PageConfig {
  slug: string;
  title: string;
  types: string[]; // e.g. ['menu_block', 'pdf_link', 'text', 'images']
  notes?: string;
}

export interface SiteConfig {
  adminUrl: string;
  customDomain?: string;
  pages: PageConfig[];
}

export interface ClientConfig {
  id: string;
  name: string;
  aliases: string[];
  contactEmails: string[];
  group?: string;
  site: SiteConfig;
}

export interface GroupConfig {
  id: string;
  name: string;
  aliases: string[];
  contactEmails: string[];
  sites: string[]; // client IDs
}

export interface SitesConfig {
  clients: ClientConfig[];
  groups: GroupConfig[];
}

export function findClientByName(
  config: SitesConfig,
  name: string,
): ClientConfig | undefined {
  const lower = name.toLowerCase();
  return config.clients.find(
    (c) =>
      c.name.toLowerCase() === lower ||
      c.id === lower ||
      c.aliases.some((a) => a.toLowerCase() === lower),
  );
}

export function findClientByEmail(
  config: SitesConfig,
  email: string,
): ClientConfig | undefined {
  const lower = email.toLowerCase();
  return config.clients.find((c) =>
    c.contactEmails.some((e) => e.toLowerCase() === lower),
  );
}

export function findGroupByName(
  config: SitesConfig,
  name: string,
): GroupConfig | undefined {
  const lower = name.toLowerCase();
  return config.groups.find(
    (g) =>
      g.name.toLowerCase() === lower ||
      g.id === lower ||
      g.aliases.some((a) => a.toLowerCase() === lower),
  );
}

export function getClientsInGroup(
  config: SitesConfig,
  groupId: string,
): ClientConfig[] {
  const group = config.groups.find((g) => g.id === groupId);
  if (!group) return [];
  return config.clients.filter((c) => group.sites.includes(c.id));
}
