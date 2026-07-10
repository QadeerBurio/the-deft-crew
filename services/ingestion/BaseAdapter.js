// services/ingestion/BaseAdapter.js
// ============================================================
// Base Class for Ingestion Adapters
// ============================================================

class BaseAdapter {
  constructor(name) {
    this.name = name; // Adapter name e.g. 'lever', 'greenhouse', etc.
  }

  // Abstract method to fetch jobs. Returns a normalized array.
  async fetchJobs() {
    throw new Error(`fetchJobs() not implemented in adapter ${this.name}`);
  }

  // Strip HTML tags from text
  stripHtml(html) {
    if (!html) return '';
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Map category strings to the standardized Job enum categories
  // Allowed categories: ["Technology", "Marketing", "Sales", "Finance", "HR", "Operations", "Design", "Other"]
  mapCategory(categoryStr) {
    if (!categoryStr) return 'Other';
    const c = categoryStr.toLowerCase();
    
    // 1. Technology
    if (c.includes('software') || c.includes('dev') || c.includes('tech') || c.includes('data') || 
        c.includes('qa') || c.includes('computer') || c.includes('web') || c.includes('programming') || 
        c.includes('ai') || c.includes('ml') || c.includes('cyber') || c.includes('information technology') || 
        c.includes('it specialist') || c.includes('systems administrator') || c.includes('network')) {
      return 'Technology';
    }
    
    // 2. Marketing
    if (c.includes('marketing') || c.includes('social') || c.includes('growth') || 
        c.includes('content') || c.includes('brand') || c.includes('seo') || 
        c.includes('advertising') || c.includes('public relations') || c.includes('pr')) {
      return 'Marketing';
    }
    
    // 3. Sales
    if (c.includes('sales') || c.includes('biz') || c.includes('business dev') || 
        c.includes('selling') || c.includes('account executive') || c.includes('retail') || 
        c.includes('telesales') || c.includes('account manager')) {
      return 'Sales';
    }
    
    // 4. Finance
    if (c.includes('finance') || c.includes('account') || c.includes('tax') || 
        c.includes('audit') || c.includes('banking') || c.includes('investment') || 
        c.includes('treasury') || c.includes('bookkeeper') || c.includes('insurance')) {
      return 'Finance';
    }
    
    // 5. HR
    if (c.includes('hr') || c.includes('recruiting') || c.includes('people') || 
        c.includes('talent') || c.includes('human resource')) {
      return 'HR';
    }
    
    // 6. Operations
    if (c.includes('operations') || c.includes('support') || c.includes('admin') || 
        c.includes('customer success') || c.includes('customer service') || c.includes('call center') ||
        c.includes('supply chain') || c.includes('logistics') || c.includes('procurement') || 
        c.includes('warehouse') || c.includes('hospitality') || c.includes('clerical') || 
        c.includes('receptionist')) {
      return 'Operations';
    }
    
    // 7. Design
    if (c.includes('design') || c.includes('ux') || c.includes('ui') || 
        c.includes('creative') || c.includes('graphics') || c.includes('animator') || 
        c.includes('architect') || c.includes('fashion') || c.includes('textile')) {
      return 'Design';
    }
    
    // 8. Other (Healthcare, Engineering, Education, Law, NGOs, etc.)
    return 'Other';
  }

  // Map employment types to standardized Job type enum
  // Allowed types: ["Full-time", "Part-time", "Contract", "Internship", "Temporary"]
  mapEmploymentType(typeStr) {
    if (!typeStr) return 'Full-time';
    const t = typeStr.toLowerCase();
    if (t.includes('full') || t.includes('permanent')) return 'Full-time';
    if (t.includes('part')) return 'Part-time';
    if (t.includes('contract') || t.includes('freelance')) return 'Contract';
    if (t.includes('intern') || t.includes('co-op') || t.includes('fellow')) return 'Internship';
    if (t.includes('temp') || t.includes('casual') || t.includes('contractor') || t.includes('seasonal')) return 'Temporary';
    return 'Full-time';
  }

  // Extract skills/technologies from text description based on key tech dictionary
  extractSkillsFromText(text) {
    if (!text) return [];
    
    // Comprehensive Multi-Industry Dictionary
    const skillsDictionary = [
      // IT/Tech
      'javascript', 'typescript', 'python', 'java', 'kotlin', 'swift', 'objective-c',
      'c++', 'c#', 'golang', 'rust', 'php', 'ruby', 'sql', 'nosql', 'mongodb', 'postgresql',
      'mysql', 'oracle', 'redis', 'react', 'react native', 'angular', 'vue', 'next.js',
      'node.js', 'express', 'django', 'flask', 'fastapi', 'spring boot', 'laravel',
      'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'jenkins', 'git', 'github',
      'html', 'css', 'sass', 'tailwind', 'bootstrap', 'figma', 'jira', 'confluence',
      'machine learning', 'deep learning', 'tensorflow', 'pytorch', 'scikit-learn',
      'pandas', 'numpy', 'scipy', 'nlp', 'computer vision', 'devops', 'ci/cd',
      'agile', 'scrum', 'rest api', 'graphql', 'websockets', 'redux',
      // Marketing/Sales
      'seo', 'sem', 'google analytics', 'copywriting', 'digital marketing', 'content creation',
      'social media marketing', 'salesforce', 'crm', 'cold calling', 'negotiation', 'lead generation',
      'public relations', 'email marketing', 'market research', 'branding',
      // Finance/Accounting
      'accounting', 'bookkeeping', 'quickbooks', 'sap', 'excel', 'financial analysis', 'taxation',
      'financial modeling', 'audit', 'general ledger', 'risk assessment', 'wealth management',
      // HR/Management
      'recruiting', 'talent acquisition', 'onboarding', 'conflict resolution', 'performance management',
      'team leadership', 'project management', 'scrum master', 'hiring',
      // Operations/Logistics
      'procurement', 'logistics', 'supply chain management', 'inventory control', 'customer support',
      'customer service', 'data entry', 'scheduling', 'administrative support', 'clerical support',
      // Healthcare/Medical
      'patient care', 'cpr', 'nursing care', 'first aid', 'clinical research', 'patient assessment',
      'phlebotomy', 'medical billing', 'pharmacology', 'anatomy',
      // Engineering (Non-IT)
      'autocad', 'solidworks', 'matlab', 'revit', 'circuit design', 'plc programming',
      'structural analysis', 'project engineering', 'preventive maintenance', 'quality control',
      // Education/Other
      'teaching', 'lesson planning', 'classroom management', 'curriculum development', 'pedagogy',
      'translation', 'legal research', 'contract drafting', 'public speaking', 'research methodology'
    ];

    const matched = [];
    const lowerText = text.toLowerCase();
    
    skillsDictionary.forEach(term => {
      // Use boundary regex to match whole words/phrases to prevent substring false positives
      const escaped = term.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      if (regex.test(lowerText)) {
        // Return capitalized form
        matched.push(term.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
      }
    });

    return matched;
  }
}

module.exports = BaseAdapter;
