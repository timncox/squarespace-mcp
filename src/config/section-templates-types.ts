/**
 * TypeScript interfaces for the Squarespace section template catalog.
 *
 * The catalog (section-templates.json) maps Squarespace Fluid Engine template
 * categories to their available templates, including placeholder text patterns
 * that the browser agent uses for searchText-based replacements.
 */

export interface TemplatePlaceholder {
  default: string;
  role: string;
}

export interface ImagePlaceholder {
  role: string;
  position?: string;
}

export interface TemplateCatalogEntry {
  index: number;
  name: string;
  description: string;
  layout: string;
  placeholders: {
    texts: TemplatePlaceholder[];
    buttons?: TemplatePlaceholder[];
    images?: ImagePlaceholder[];
  };
  bestFor: string[];
}

export interface TemplateCategoryEntry {
  category: string;
  templates: TemplateCatalogEntry[];
}

export type TemplateCatalog = TemplateCategoryEntry[];
