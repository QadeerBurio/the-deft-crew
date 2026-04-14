// Add this at the beginning of your data/Template.js file
const addDefaultFields = (template) => {
  return {
    id: template.id,
    name: template.name,
    category: template.category || 'modern',
    description: template.description || `${template.name} template design`,
    colors: template.colors || ['#4f46e5', '#818cf8'],
    fonts: template.fonts || { heading: 'Helvetica-Bold', body: 'Helvetica' },
    layout: template.layout || 'single-column',
    bestFor: template.bestFor || ['All'],
    industries: template.industries || ['All'],
    experienceLevel: template.experienceLevel || ['entry', 'mid', 'senior'],
    isActive: template.isActive !== undefined ? template.isActive : true,
    popularity: template.popularity || 0
  };
};

const templatesData = [
  // MODERN CATEGORY (1-20)
  { id: 'modern_001', name: 'Aero', category: 'modern', description: 'Clean modern design with gradient header', colors: ['#4f46e5', '#818cf8'], layout: 'single-column', bestFor: ['Tech', 'Creative'], industries: ['IT', 'Design', 'Marketing'], experienceLevel: ['entry', 'mid'] },
  { id: 'modern_002', name: 'Nova', category: 'modern', description: 'Bold typography with accent colors', colors: ['#ec4899', '#f43f5e'], layout: 'single-column', bestFor: ['Creative', 'Marketing'], industries: ['Advertising', 'Media'], experienceLevel: ['entry', 'mid'] },
  { id: 'modern_003', name: 'Vertex', category: 'modern', description: 'Geometric patterns and modern layout', colors: ['#06b6d4', '#3b82f6'], layout: 'sidebar-right', bestFor: ['Tech'], industries: ['Software', 'Engineering'], experienceLevel: ['mid', 'senior'] },
  { id: 'modern_004', name: 'Eclipse', category: 'modern', description: 'Dark mode ready professional design', colors: ['#1e293b', '#334155'], layout: 'two-column', bestFor: ['Tech', 'Executive'], industries: ['Corporate', 'Finance'], experienceLevel: ['senior', 'executive'] },
  { id: 'modern_005', name: 'Zenith', category: 'modern', description: 'Minimalist with focus on content', colors: ['#64748b', '#94a3b8'], layout: 'single-column', bestFor: ['Academic'], industries: ['Education', 'Research'], experienceLevel: ['entry', 'mid'] },
  { id: 'modern_006', name: 'Apex', category: 'modern', description: 'Bold header with timeline experience', colors: ['#0ea5e9', '#0284c7'], layout: 'single-column', bestFor: ['Tech'], industries: ['IT', 'Engineering'], experienceLevel: ['mid', 'senior'] },
  { id: 'modern_007', name: 'Stellar', category: 'modern', description: 'Skills-focused modern template', colors: ['#8b5cf6', '#7c3aed'], layout: 'sidebar-left', bestFor: ['Creative'], industries: ['Design', 'Art'], experienceLevel: ['entry', 'mid'] },
  { id: 'modern_008', name: 'Orbit', category: 'modern', description: 'Circular elements and modern fonts', colors: ['#f59e0b', '#d97706'], layout: 'two-column', bestFor: ['Marketing'], industries: ['Sales', 'Business'], experienceLevel: ['mid'] },
  { id: 'modern_009', name: 'Quantum', category: 'modern', description: 'Tech-focused with skill graphs', colors: ['#10b981', '#059669'], layout: 'single-column', bestFor: ['Tech'], industries: ['Software', 'Data Science'], experienceLevel: ['mid', 'senior'] },
  { id: 'modern_010', name: 'Nexus', category: 'modern', description: 'Connected design with progress bars', colors: ['#6366f1', '#4f46e5'], layout: 'sidebar-right', bestFor: ['Executive'], industries: ['Management', 'Leadership'], experienceLevel: ['senior', 'executive'] },
  { id: 'modern_011', name: 'Prism', category: 'modern', description: 'Colorful accent sections', colors: ['#d946ef', '#c026d3'], layout: 'two-column', bestFor: ['Creative'], industries: ['Art', 'Fashion'], experienceLevel: ['entry'] },
  { id: 'modern_012', name: 'Echo', category: 'modern', description: 'Subtle shadows and depth', colors: ['#78716c', '#a8a29e'], layout: 'single-column', bestFor: ['Professional'], industries: ['Legal', 'Consulting'], experienceLevel: ['mid', 'senior'] },
  { id: 'modern_013', name: 'Pulse', category: 'modern', description: 'Dynamic layout with icons', colors: ['#ef4444', '#dc2626'], layout: 'sidebar-left', bestFor: ['Tech'], industries: ['Healthcare', 'Tech'], experienceLevel: ['entry', 'mid'] },
  { id: 'modern_014', name: 'Ripple', category: 'modern', description: 'Fluid design with rounded corners', colors: ['#14b8a6', '#0d9488'], layout: 'single-column', bestFor: ['Creative'], industries: ['Design', 'Architecture'], experienceLevel: ['mid'] },
  { id: 'modern_015', name: 'Spark', category: 'modern', description: 'Energy-focused modern template', colors: ['#f97316', '#ea580c'], layout: 'two-column', bestFor: ['Marketing'], industries: ['Advertising', 'PR'], experienceLevel: ['entry', 'mid'] },
  { id: 'modern_016', name: 'Vista', category: 'modern', description: 'Wide layout with side panels', colors: ['#3b82f6', '#2563eb'], layout: 'sidebar-right', bestFor: ['Executive'], industries: ['Corporate', 'Finance'], experienceLevel: ['senior', 'executive'] },
  { id: 'modern_017', name: 'Horizon', category: 'modern', description: 'Horizontal timeline for experience', colors: ['#8b5cf6', '#a78bfa'], layout: 'single-column', bestFor: ['Tech'], industries: ['Engineering', 'Product'], experienceLevel: ['mid', 'senior'] },
  { id: 'modern_018', name: 'Element', category: 'modern', description: 'Modular block design', colors: ['#06b6d4', '#22d3ee'], layout: 'two-column', bestFor: ['Creative'], industries: ['Media', 'Entertainment'], experienceLevel: ['entry'] },
  { id: 'modern_019', name: 'Fusion', category: 'modern', description: 'Mixed layout with emphasis on skills', colors: ['#ec4899', '#f472b6'], layout: 'sidebar-left', bestFor: ['Tech'], industries: ['IT', 'DevOps'], experienceLevel: ['mid'] },
  { id: 'modern_020', name: 'Unity', category: 'modern', description: 'Balanced two-column design', colors: ['#64748b', '#475569'], layout: 'two-column', bestFor: ['Professional'], industries: ['Business', 'Administration'], experienceLevel: ['mid', 'senior'] },
  
  // CLASSIC CATEGORY (21-40)
  { id: 'classic_001', name: 'Heritage', category: 'classic', description: 'Traditional timeless design', colors: ['#1e293b', '#334155'], layout: 'single-column', bestFor: ['Corporate', 'Legal'], industries: ['Law', 'Finance'], experienceLevel: ['senior', 'executive'] },
  { id: 'classic_002', name: 'Legacy', category: 'classic', description: 'Elegant serif fonts', colors: ['#0f172a', '#1e293b'], layout: 'single-column', bestFor: ['Academic', 'Executive'], industries: ['Education', 'Government'], experienceLevel: ['senior', 'executive'] },
  { id: 'classic_003', name: 'Tradition', category: 'classic', description: 'Conservative professional layout', colors: ['#2d3748', '#4a5568'], layout: 'single-column', bestFor: ['Corporate'], industries: ['Banking', 'Insurance'], experienceLevel: ['mid', 'senior'] },
  { id: 'classic_004', name: 'Timeless', category: 'classic', description: 'Simple and effective design', colors: ['#1a202c', '#2d3748'], layout: 'single-column', bestFor: ['Professional'], industries: ['Consulting', 'Management'], experienceLevel: ['mid', 'senior'] },
  { id: 'classic_005', name: 'Standard', category: 'classic', description: 'Standard ATS-friendly format', colors: ['#4a5568', '#718096'], layout: 'single-column', bestFor: ['All'], industries: ['All'], experienceLevel: ['entry', 'mid', 'senior'] },
  { id: 'classic_006', name: 'Executive', category: 'classic', description: 'Premium executive design', colors: ['#1e3a8a', '#1e40af'], layout: 'single-column', bestFor: ['Executive'], industries: ['C-Suite', 'Director'], experienceLevel: ['executive'] },
  { id: 'classic_007', name: 'Professional', category: 'classic', description: 'Clean professional layout', colors: ['#374151', '#4b5563'], layout: 'single-column', bestFor: ['Professional'], industries: ['Corporate', 'Business'], experienceLevel: ['mid', 'senior'] },
  { id: 'classic_008', name: 'Elegant', category: 'classic', description: 'Elegant design with borders', colors: ['#78350f', '#92400e'], layout: 'single-column', bestFor: ['Executive'], industries: ['Luxury', 'Hospitality'], experienceLevel: ['senior', 'executive'] },
  { id: 'classic_009', name: 'Refined', category: 'classic', description: 'Refined typography', colors: ['#1e1b4b', '#312e81'], layout: 'sidebar-left', bestFor: ['Academic'], industries: ['Research', 'Education'], experienceLevel: ['senior'] },
  { id: 'classic_010', name: 'Polished', category: 'classic', description: 'Polished corporate look', colors: ['#0f172a', '#1e293b'], layout: 'two-column', bestFor: ['Management'], industries: ['Operations', 'HR'], experienceLevel: ['mid', 'senior'] },
  { id: 'classic_011', name: 'Dignified', category: 'classic', description: 'Dignified design for seniors', colors: ['#450a0a', '#7f1d1d'], layout: 'single-column', bestFor: ['Executive'], industries: ['Legal', 'Government'], experienceLevel: ['senior', 'executive'] },
  { id: 'classic_012', name: 'Sovereign', category: 'classic', description: 'Leadership-focused design', colors: ['#14532d', '#166534'], layout: 'sidebar-right', bestFor: ['Executive'], industries: ['Management', 'Leadership'], experienceLevel: ['executive'] },
  { id: 'classic_013', name: 'Noble', category: 'classic', description: 'Noble and distinguished', colors: ['#4c1d95', '#5b21b6'], layout: 'single-column', bestFor: ['Executive'], industries: ['Consulting', 'Strategy'], experienceLevel: ['senior', 'executive'] },
  { id: 'classic_014', name: 'Regal', category: 'classic', description: 'Regal design with accents', colors: ['#831843', '#9d174d'], layout: 'two-column', bestFor: ['Executive'], industries: ['Executive', 'Board'], experienceLevel: ['executive'] },
  { id: 'classic_015', name: 'Prestige', category: 'classic', description: 'Prestigious layout', colors: ['#164e63', '#155e75'], layout: 'single-column', bestFor: ['Executive'], industries: ['Corporate', 'Finance'], experienceLevel: ['senior', 'executive'] },
  { id: 'classic_016', name: 'Vanguard', category: 'classic', description: 'Forward-thinking classic', colors: ['#334155', '#475569'], layout: 'sidebar-left', bestFor: ['Professional'], industries: ['Tech', 'Finance'], experienceLevel: ['mid', 'senior'] },
  { id: 'classic_017', name: 'Benchmark', category: 'classic', description: 'Industry standard design', colors: ['#64748b', '#94a3b8'], layout: 'single-column', bestFor: ['All'], industries: ['All'], experienceLevel: ['entry', 'mid', 'senior'] },
  { id: 'classic_018', name: 'Cornerstone', category: 'classic', description: 'Solid foundational design', colors: ['#451a03', '#713f12'], layout: 'single-column', bestFor: ['Professional'], industries: ['Construction', 'Real Estate'], experienceLevel: ['mid', 'senior'] },
  { id: 'classic_019', name: 'Pillar', category: 'classic', description: 'Strong corporate layout', colors: ['#1c1917', '#292524'], layout: 'two-column', bestFor: ['Executive'], industries: ['Corporate', 'Management'], experienceLevel: ['senior'] },
  { id: 'classic_020', name: 'Foundation', category: 'classic', description: 'Stable professional design', colors: ['#2e1065', '#4c1d95'], layout: 'single-column', bestFor: ['Professional'], industries: ['Education', 'Non-profit'], experienceLevel: ['mid'] },
  
  // CREATIVE CATEGORY (41-60)
  { id: 'creative_001', name: 'Artisan', category: 'creative', description: 'Artistic portfolio style', colors: ['#db2777', '#be185d'], layout: 'two-column', bestFor: ['Creative'], industries: ['Art', 'Design'], experienceLevel: ['entry', 'mid'] },
  { id: 'creative_002', name: 'Canvas', category: 'creative', description: 'Blank canvas creative layout', colors: ['#ea580c', '#c2410c'], layout: 'sidebar-right', bestFor: ['Creative'], industries: ['Photography', 'Art'], experienceLevel: ['entry'] },
  { id: 'creative_003', name: 'Palette', category: 'creative', description: 'Colorful design-focused', colors: ['#7c3aed', '#6d28d9'], layout: 'single-column', bestFor: ['Creative'], industries: ['Graphic Design', 'UI/UX'], experienceLevel: ['entry', 'mid'] },
  { id: 'creative_004', name: 'Mosaic', category: 'creative', description: 'Unique mosaic layout', colors: ['#0891b2', '#0e7490'], layout: 'three-column', bestFor: ['Creative'], industries: ['Art', 'Media'], experienceLevel: ['mid'] },
  { id: 'creative_005', name: 'Origami', category: 'creative', description: 'Geometric folded design', colors: ['#f59e0b', '#d97706'], layout: 'sidebar-left', bestFor: ['Creative'], industries: ['Architecture', 'Design'], experienceLevel: ['mid'] },
  { id: 'creative_006', name: 'Spectrum', category: 'creative', description: 'Full color spectrum', colors: ['#ec4899', '#f43f5e', '#f97316', '#10b981'], layout: 'two-column', bestFor: ['Creative'], industries: ['Marketing', 'Advertising'], experienceLevel: ['entry', 'mid'] },
  { id: 'creative_007', name: 'Doodle', category: 'creative', description: 'Playful hand-drawn style', colors: ['#84cc16', '#65a30d'], layout: 'single-column', bestFor: ['Creative'], industries: ['Education', 'Children'], experienceLevel: ['entry'] },
  { id: 'creative_008', name: 'Inkwell', category: 'creative', description: 'Ink sketch style', colors: ['#1e293b', '#334155'], layout: 'sidebar-right', bestFor: ['Creative'], industries: ['Writing', 'Publishing'], experienceLevel: ['mid', 'senior'] },
  { id: 'creative_009', name: 'Pixel', category: 'creative', description: 'Modern pixel-perfect design', colors: ['#14b8a6', '#0d9488'], layout: 'two-column', bestFor: ['Tech'], industries: ['Web Design', 'Development'], experienceLevel: ['entry', 'mid'] },
  { id: 'creative_010', name: 'Vector', category: 'creative', description: 'Clean vector graphics style', colors: ['#3b82f6', '#2563eb'], layout: 'single-column', bestFor: ['Tech'], industries: ['Graphic Design', 'Illustration'], experienceLevel: ['mid'] },
  { id: 'creative_011', name: 'Abstract', category: 'creative', description: 'Abstract shapes and forms', colors: ['#a855f7', '#8b5cf6'], layout: 'sidebar-left', bestFor: ['Creative'], industries: ['Art', 'Fashion'], experienceLevel: ['entry', 'mid'] },
  { id: 'creative_012', name: 'Flow', category: 'creative', description: 'Fluid organic shapes', colors: ['#06b6d4', '#22d3ee'], layout: 'single-column', bestFor: ['Creative'], industries: ['Wellness', 'Yoga'], experienceLevel: ['entry'] },
  { id: 'creative_013', name: 'Retro', category: 'creative', description: 'Vintage-inspired design', colors: ['#fcd34d', '#fbbf24'], layout: 'two-column', bestFor: ['Creative'], industries: ['Vintage', 'Heritage'], experienceLevel: ['mid'] },
  { id: 'creative_014', name: 'Neon', category: 'creative', description: 'Bold neon accents', colors: ['#10b981', '#34d399'], layout: 'sidebar-right', bestFor: ['Creative'], industries: ['Nightlife', 'Entertainment'], experienceLevel: ['entry'] },
  { id: 'creative_015', name: 'Gradient', category: 'creative', description: 'Beautiful gradient overlays', colors: ['#f43f5e', '#e11d48', '#fb7185'], layout: 'single-column', bestFor: ['Creative'], industries: ['Marketing', 'Branding'], experienceLevel: ['mid'] },
  { id: 'creative_016', name: 'Pop', category: 'creative', description: 'Pop art inspired', colors: ['#facc15', '#eab308', '#ca8a04'], layout: 'two-column', bestFor: ['Creative'], industries: ['Entertainment', 'Media'], experienceLevel: ['entry'] },
  { id: 'creative_017', name: 'Sketch', category: 'creative', description: 'Hand-sketch style', colors: ['#78716c', '#a8a29e'], layout: 'sidebar-left', bestFor: ['Creative'], industries: ['Architecture', 'Design'], experienceLevel: ['mid'] },
  { id: 'creative_018', name: 'Watercolor', category: 'creative', description: 'Soft watercolor effects', colors: ['#67e8f9', '#22d3ee', '#06b6d4'], layout: 'single-column', bestFor: ['Creative'], industries: ['Art', 'Photography'], experienceLevel: ['entry'] },
  { id: 'creative_019', name: 'Street', category: 'creative', description: 'Urban street style', colors: ['#9ca3af', '#6b7280', '#4b5563'], layout: 'two-column', bestFor: ['Creative'], industries: ['Urban', 'Fashion'], experienceLevel: ['entry'] },
  { id: 'creative_020', name: 'Boho', category: 'creative', description: 'Bohemian free-spirited', colors: ['#fde047', '#fef08a', '#eab308'], layout: 'sidebar-right', bestFor: ['Creative'], industries: ['Lifestyle', 'Wellness'], experienceLevel: ['entry'] },
  
  // PROFESSIONAL CATEGORY (61-80)
  { id: 'professional_001', name: 'Elite', category: 'professional', description: 'Elite corporate design', colors: ['#1e3a8a', '#1e40af'], layout: 'two-column', bestFor: ['Executive'], industries: ['Finance', 'Law'], experienceLevel: ['senior', 'executive'] },
  { id: 'professional_002', name: 'Prime', category: 'professional', description: 'Prime professional layout', colors: ['#065f46', '#047857'], layout: 'single-column', bestFor: ['Professional'], industries: ['Healthcare', 'Medical'], experienceLevel: ['mid', 'senior'] },
  { id: 'professional_003', name: 'Peak', category: 'professional', description: 'Peak performance design', colors: ['#4338ca', '#3730a3'], layout: 'sidebar-left', bestFor: ['Executive'], industries: ['Sales', 'Business'], experienceLevel: ['senior'] },
  { id: 'professional_004', name: 'Summit', category: 'professional', description: 'Summit executive style', colors: ['#9a3412', '#7c2d12'], layout: 'single-column', bestFor: ['Executive'], industries: ['Real Estate', 'Construction'], experienceLevel: ['senior', 'executive'] },
  { id: 'professional_005', name: 'Clarity', category: 'professional', description: 'Clear and organized', colors: ['#475569', '#64748b'], layout: 'two-column', bestFor: ['Professional'], industries: ['Administration', 'Office'], experienceLevel: ['mid'] },
  { id: 'professional_006', name: 'Precision', category: 'professional', description: 'Precision engineering style', colors: ['#1e293b', '#0f172a'], layout: 'single-column', bestFor: ['Tech'], industries: ['Engineering', 'Science'], experienceLevel: ['mid', 'senior'] },
  { id: 'professional_007', name: 'Merit', category: 'professional', description: 'Merit-based achievement focus', colors: ['#854d0e', '#a16207'], layout: 'sidebar-right', bestFor: ['Professional'], industries: ['Education', 'Research'], experienceLevel: ['mid', 'senior'] },
  { id: 'professional_008', name: 'Virtue', category: 'professional', description: 'Virtuous professional design', colors: ['#166534', '#15803d'], layout: 'two-column', bestFor: ['Professional'], industries: ['Non-profit', 'Social Work'], experienceLevel: ['mid'] },
  { id: 'professional_009', name: 'Integrity', category: 'professional', description: 'Integrity-focused layout', colors: ['#1e3a8a', '#1d4ed8'], layout: 'single-column', bestFor: ['Professional'], industries: ['Legal', 'Compliance'], experienceLevel: ['senior'] },
  { id: 'professional_010', name: 'Excellence', category: 'professional', description: 'Excellence in design', colors: ['#991b1b', '#b91c1c'], layout: 'sidebar-left', bestFor: ['Executive'], industries: ['Management', 'Leadership'], experienceLevel: ['executive'] },
  { id: 'professional_011', name: 'Mastery', category: 'professional', description: 'Master craftsman style', colors: ['#4c1d95', '#5b21b6'], layout: 'two-column', bestFor: ['Professional'], industries: ['Skilled Trade', 'Craft'], experienceLevel: ['senior'] },
  { id: 'professional_012', name: 'Wisdom', category: 'professional', description: 'Wisdom-focused design', colors: ['#78350f', '#92400e'], layout: 'single-column', bestFor: ['Professional'], industries: ['Consulting', 'Advisory'], experienceLevel: ['senior', 'executive'] },
  { id: 'professional_013', name: 'Legacy', category: 'professional', description: 'Legacy building layout', colors: ['#0f172a', '#1e293b'], layout: 'sidebar-right', bestFor: ['Executive'], industries: ['Family Business', 'Legacy'], experienceLevel: ['executive'] },
  { id: 'professional_014', name: 'Horizon', category: 'professional', description: 'Future-focused design', colors: ['#075985', '#0e7490'], layout: 'two-column', bestFor: ['Professional'], industries: ['Tech', 'Innovation'], experienceLevel: ['mid', 'senior'] },
  { id: 'professional_015', name: 'Pathway', category: 'professional', description: 'Career pathway layout', colors: ['#2d3748', '#4a5568'], layout: 'single-column', bestFor: ['Professional'], industries: ['Career Development', 'Coaching'], experienceLevel: ['mid'] },
  { id: 'professional_016', name: 'Ascent', category: 'professional', description: 'Career ascent design', colors: ['#b45309', '#d97706'], layout: 'sidebar-left', bestFor: ['Professional'], industries: ['Sales', 'Marketing'], experienceLevel: ['mid', 'senior'] },
  { id: 'professional_017', name: 'Momentum', category: 'professional', description: 'Momentum-building layout', colors: ['#059669', '#10b981'], layout: 'two-column', bestFor: ['Professional'], industries: ['Startup', 'Entrepreneur'], experienceLevel: ['mid'] },
  { id: 'professional_018', name: 'Trajectory', category: 'professional', description: 'Career trajectory focus', colors: ['#2563eb', '#3b82f6'], layout: 'single-column', bestFor: ['Professional'], industries: ['Tech', 'Growth'], experienceLevel: ['mid', 'senior'] },
  { id: 'professional_019', name: 'Catalyst', category: 'professional', description: 'Change catalyst design', colors: ['#db2777', '#be185d'], layout: 'sidebar-right', bestFor: ['Professional'], industries: ['Change Management', 'HR'], experienceLevel: ['senior'] },
  { id: 'professional_020', name: 'Synergy', category: 'professional', description: 'Team synergy layout', colors: ['#7c3aed', '#6d28d9'], layout: 'two-column', bestFor: ['Professional'], industries: ['Team Building', 'Collaboration'], experienceLevel: ['mid'] },
  
  // MINIMAL CATEGORY (81-100)
  { id: 'minimal_001', name: 'Pure', category: 'minimal', description: 'Pure minimal design', colors: ['#ffffff', '#f8fafc'], layout: 'single-column', bestFor: ['Creative'], industries: ['Design', 'Art'], experienceLevel: ['entry', 'mid'] },
  { id: 'minimal_002', name: 'Blank', category: 'minimal', description: 'Clean slate design', colors: ['#f1f5f9', '#e2e8f0'], layout: 'single-column', bestFor: ['All'], industries: ['All'], experienceLevel: ['entry'] },
  { id: 'minimal_003', name: 'Air', category: 'minimal', description: 'Light and airy', colors: ['#ffffff', '#fefce8'], layout: 'sidebar-left', bestFor: ['Creative'], industries: ['Wellness', 'Lifestyle'], experienceLevel: ['entry'] },
  { id: 'minimal_004', name: 'Space', category: 'minimal', description: 'Generous white space', colors: ['#faf5ff', '#f3e8ff'], layout: 'two-column', bestFor: ['Creative'], industries: ['Design', 'Architecture'], experienceLevel: ['mid'] },
  { id: 'minimal_005', name: 'Calm', category: 'minimal', description: 'Peaceful minimal design', colors: ['#ecfdf5', '#d1fae5'], layout: 'single-column', bestFor: ['Professional'], industries: ['Healthcare', 'Wellness'], experienceLevel: ['mid'] },
  { id: 'minimal_006', name: 'Clear', category: 'minimal', description: 'Crystal clear layout', colors: ['#eff6ff', '#dbeafe'], layout: 'sidebar-right', bestFor: ['Professional'], industries: ['Tech', 'Science'], experienceLevel: ['mid', 'senior'] },
  { id: 'minimal_007', name: 'Focus', category: 'minimal', description: 'Focus-driven design', colors: ['#fff7ed', '#ffedd5'], layout: 'single-column', bestFor: ['Professional'], industries: ['Productivity', 'Management'], experienceLevel: ['mid'] },
  { id: 'minimal_008', name: 'Zen', category: 'minimal', description: 'Zen-inspired minimalism', colors: ['#fef2f2', '#fee2e2'], layout: 'two-column', bestFor: ['Creative'], industries: ['Meditation', 'Wellness'], experienceLevel: ['entry'] },
  { id: 'minimal_009', name: 'Flow', category: 'minimal', description: 'Effortless flow', colors: ['#fdf4ff', '#fae8ff'], layout: 'single-column', bestFor: ['Creative'], industries: ['Art', 'Design'], experienceLevel: ['entry'] },
  { id: 'minimal_010', name: 'Essence', category: 'minimal', description: 'Core essentials only', colors: ['#fefce8', '#fef08a'], layout: 'sidebar-left', bestFor: ['Professional'], industries: ['Minimalist', 'Essential'], experienceLevel: ['entry', 'mid'] },
  { id: 'minimal_011', name: 'Core', category: 'minimal', description: 'Core focus design', colors: ['#f1f5f9', '#cbd5e1'], layout: 'single-column', bestFor: ['Professional'], industries: ['Core Business'], experienceLevel: ['mid', 'senior'] },
  { id: 'minimal_012', name: 'Base', category: 'minimal', description: 'Foundation base layout', colors: ['#f8fafc', '#e2e8f0'], layout: 'two-column', bestFor: ['All'], industries: ['All'], experienceLevel: ['entry'] },
  { id: 'minimal_013', name: 'Prime', category: 'minimal', description: 'Prime minimal design', colors: ['#fef3c7', '#fde68a'], layout: 'single-column', bestFor: ['Professional'], industries: ['Creative', 'Marketing'], experienceLevel: ['mid'] },
  { id: 'minimal_014', name: 'Fine', category: 'minimal', description: 'Fine details matter', colors: ['#e0e7ff', '#c7d2fe'], layout: 'sidebar-right', bestFor: ['Professional'], industries: ['Legal', 'Detail-oriented'], experienceLevel: ['senior'] },
  { id: 'minimal_015', name: 'Sharp', category: 'minimal', description: 'Crisp sharp design', colors: ['#f1f5f9', '#e2e8f0'], layout: 'single-column', bestFor: ['Tech'], industries: ['Software', 'Development'], experienceLevel: ['mid'] },
  { id: 'minimal_016', name: 'Edge', category: 'minimal', description: 'Cutting-edge minimal', colors: ['#f8fafc', '#94a3b8'], layout: 'two-column', bestFor: ['Tech'], industries: ['Innovation', 'Tech'], experienceLevel: ['mid', 'senior'] },
  { id: 'minimal_017', name: 'Sleek', category: 'minimal', description: 'Sleek modern minimal', colors: ['#ffffff', '#f1f5f9'], layout: 'sidebar-left', bestFor: ['Professional'], industries: ['Design', 'Tech'], experienceLevel: ['mid'] },
  { id: 'minimal_018', name: 'Clean', category: 'minimal', description: 'Ultra-clean layout', colors: ['#f9fafb', '#e5e7eb'], layout: 'single-column', bestFor: ['All'], industries: ['All'], experienceLevel: ['entry', 'mid'] },
  { id: 'minimal_019', name: 'Neat', category: 'minimal', description: 'Neat and organized', colors: ['#f0fdf4', '#dcfce7'], layout: 'two-column', bestFor: ['Professional'], industries: ['Organization', 'Planning'], experienceLevel: ['mid'] },
  { id: 'minimal_020', name: 'Tidy', category: 'minimal', description: 'Tidy professional look', colors: ['#fef2f2', '#fee2e2'], layout: 'single-column', bestFor: ['Professional'], industries: ['Administration', 'Office'], experienceLevel: ['mid'] }
];

// Add 20 special templates
for (let i = 1; i <= 20; i++) {
  templatesData.push({
    id: `special_${String(i).padStart(3, '0')}`,
    name: `Special ${i}`,
    category: ['modern', 'creative', 'professional'][i % 3],
    description: `Unique template design ${i}`,
    colors: [`#${Math.floor(Math.random()*16777215).toString(16)}`],
    layout: ['single-column', 'two-column', 'sidebar-left', 'sidebar-right'][i % 4],
    bestFor: ['All'],
    industries: ['All'],
    experienceLevel: ['entry', 'mid', 'senior', 'executive'],
    isActive: true,
    popularity: Math.floor(Math.random() * 1000)
  });
}

// Apply default fields to all templates
const finalTemplatesData = templatesData.map(addDefaultFields);

module.exports = finalTemplatesData;