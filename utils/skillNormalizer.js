// utils/skillNormalizer.js
// Standardises skill names to canonical forms, ensuring robust exact/fuzzy matching.

const SYNONYM_MAP = {
  // Languages
  'js': 'JavaScript',
  'javascript': 'JavaScript',
  'py': 'Python',
  'python': 'Python',
  'ts': 'TypeScript',
  'typescript': 'TypeScript',
  'cpp': 'C++',
  'c++': 'C++',
  'csharp': 'C#',
  'c#': 'C#',
  'golang': 'Go',
  'go': 'Go',
  'rb': 'Ruby',
  'ruby': 'Ruby',
  'html5': 'HTML',
  'html': 'HTML',
  'css3': 'CSS',
  'css': 'CSS',

  // Frameworks & Libraries
  'react': 'React',
  'reactjs': 'React',
  'react.js': 'React',
  'react native': 'React Native',
  'reactnative': 'React Native',
  'rn': 'React Native',
  'node': 'Node.js',
  'nodejs': 'Node.js',
  'node.js': 'Node.js',
  'vue': 'Vue.js',
  'vuejs': 'Vue.js',
  'vue.js': 'Vue.js',
  'angularjs': 'Angular',
  'angular': 'Angular',
  'express': 'Express.js',
  'expressjs': 'Express.js',
  'nextjs': 'Next.js',
  'next.js': 'Next.js',
  'django': 'Django',
  'flask': 'Flask',
  'spring': 'Spring Boot',
  'springboot': 'Spring Boot',
  'spring boot': 'Spring Boot',

  // AI/ML/Data Science
  'llm': 'Large Language Models',
  'llms': 'Large Language Models',
  'large language model': 'Large Language Models',
  'large language models': 'Large Language Models',
  'genai': 'Generative AI',
  'gen ai': 'Generative AI',
  'generativeai': 'Generative AI',
  'generative ai': 'Generative AI',
  'ai agents': 'Agentic AI',
  'ai agent': 'Agentic AI',
  'agentic ai': 'Agentic AI',
  'agenticai': 'Agentic AI',
  'ml': 'Machine Learning',
  'machine learning': 'Machine Learning',
  'dl': 'Deep Learning',
  'deep learning': 'Deep Learning',
  'nlp': 'Natural Language Processing',
  'natural language processing': 'Natural Language Processing',
  'cv': 'Computer Vision',
  'computer vision': 'Computer Vision',
  'tensorflow': 'TensorFlow',
  'pytorch': 'PyTorch',
  'scikit': 'Scikit-Learn',
  'scikit-learn': 'Scikit-Learn',
  'sklearn': 'Scikit-Learn',

  // Databases & Cloud
  'mongo': 'MongoDB',
  'mongodb': 'MongoDB',
  'postgres': 'PostgreSQL',
  'postgresql': 'PostgreSQL',
  'mysql': 'MySQL',
  'redis': 'Redis',
  'aws': 'Amazon Web Services',
  'amazon web services': 'Amazon Web Services',
  'gcp': 'Google Cloud Platform',
  'google cloud': 'Google Cloud Platform',
  'google cloud platform': 'Google Cloud Platform',
  'azure': 'Microsoft Azure',
  'docker': 'Docker',
  'k8s': 'Kubernetes',
  'kubernetes': 'Kubernetes',
  'cicd': 'CI/CD',
  'ci/cd': 'CI/CD'
};

/**
 * Normalises a single skill string to its canonical representation.
 * @param {string} skill 
 * @returns {string} canonical skill name
 */
function normalizeSkill(skill) {
  if (!skill || typeof skill !== 'string') return '';
  
  // Clean: lowercase, trim, keep alphanumeric and standard symbols (+, #, -, ., /)
  const clean = skill
    .toLowerCase()
    .replace(/[^a-z0-9+#\-.\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Return canonical name from synonym map, or capitalized original if not found
  if (SYNONYM_MAP[clean]) {
    return SYNONYM_MAP[clean];
  }

  // Fallback capitalise words
  return clean
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Normalises a list of skill strings.
 * @param {Array<string>} skills 
 * @returns {Array<string>} list of unique canonical skill names
 */
function normalizeSkills(skills) {
  if (!Array.isArray(skills)) return [];
  const normalizedSet = new Set(
    skills
      .map(normalizeSkill)
      .filter(Boolean)
  );
  return Array.from(normalizedSet);
}

module.exports = {
  normalizeSkill,
  normalizeSkills,
  SYNONYM_MAP
};
