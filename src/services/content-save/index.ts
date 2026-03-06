// Re-export everything from the base client module
export * from './client.js';

// Domain method modules (prototype augmentation) — must come after client export
import './text.js';
// import './blocks.js';
// import './block-layout.js';
import './mobile.js';
// import './sections.js';
import './header-footer.js';
// import './pages.js';
import './site.js';
import './design.js';
// import './gallery.js';
import './commerce.js';
