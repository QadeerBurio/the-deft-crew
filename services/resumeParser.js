// services/resumeParser.js
const { PDFParse } = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const OpenAI = require('openai');
const axios = require('axios');

let openai;
function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

/**
 * Helper to isolate text of a specific section in fallback/regex parsing
 */
const extractSectionText = (text, sectionName) => {
  const sections = ['Summary', 'Education', 'Skills', 'Projects', 'Experience', 'Certifications', 'Languages'];
  const lowerText = text.toLowerCase();
  
  // Find start index of target section
  const targetHeader = `\n${sectionName.toLowerCase()}\n`;
  let startIndex = lowerText.indexOf(targetHeader);
  if (startIndex === -1) {
    // Try without surrounding newlines
    startIndex = lowerText.indexOf(sectionName.toLowerCase());
  }
  if (startIndex === -1) return '';
  
  // The actual section starts after the header
  startIndex += sectionName.length;
  
  // Find where the next section starts
  let nextSectionIndex = text.length;
  for (const sec of sections) {
    if (sec === sectionName) continue;
    const secHeader = `\n${sec.toLowerCase()}\n`;
    let idx = lowerText.indexOf(secHeader, startIndex);
    if (idx === -1) {
      idx = lowerText.indexOf(sec.toLowerCase(), startIndex);
    }
    if (idx !== -1 && idx < nextSectionIndex) {
      nextSectionIndex = idx;
    }
  }
  
  return text.substring(startIndex, nextSectionIndex).trim();
};

/**
 * Extract text from PDF file
 */
const extractTextFromPDF = async (filePath) => {
  try {
    console.log('📄 Extracting text from PDF...');
    let dataBuffer;
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      console.log('🌐 Fetching PDF from remote URL:', filePath);
      const response = await axios.get(filePath, { responseType: 'arraybuffer' });
      dataBuffer = Buffer.from(response.data);
    } else {
      dataBuffer = fs.readFileSync(filePath);
    }
    const parser = new PDFParse({ data: dataBuffer });
    const data = await parser.getText();
    const text = data.text || '';
    console.log(`✅ Extracted ${text.length} characters from PDF`);
    return text;
  } catch (error) {
    console.error('❌ PDF extraction error:', error);
    throw new Error('Failed to extract text from PDF: ' + error.message);
  }
};

/**
 * Extract text from Word document
 */
const extractTextFromWord = async (filePath) => {
  try {
    console.log('📄 Extracting text from Word document...');
    let dataBuffer;
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      console.log('🌐 Fetching Word document from remote URL:', filePath);
      const response = await axios.get(filePath, { responseType: 'arraybuffer' });
      dataBuffer = Buffer.from(response.data);
    } else {
      dataBuffer = fs.readFileSync(filePath);
    }
    const result = await mammoth.extractRawText({ buffer: dataBuffer });
    const text = result.value || '';
    console.log(`✅ Extracted ${text.length} characters from Word document`);
    return text;
  } catch (error) {
    console.error('❌ Word extraction error:', error);
    throw new Error('Failed to extract text from Word document: ' + error.message);
  }
};

/**
 * Parse personal information from text
 */
const parsePersonalInfo = (text) => {
  console.log('🔍 Parsing personal information...');
  
  const lines = text.split('\n').filter(line => line.trim());
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const phoneRegex = /(?:\+92|0)?\s?3[0-9]{2}[-\s]?[0-9]{7}|(?:\+92|0)?\s?3[0-9]{2}[-\s]?[0-9]{3}[-\s]?[0-9]{4}|(?:\+\d{1,3}[-.]?)?\(?\d{3}\)?[-.]?\d{3}[-.]?\d{4}/;
  const linkedinRegex = /linkedin\.com\/in\/[a-zA-Z0-9-]+/;
  const githubRegex = /github\.com\/[a-zA-Z0-9-]+/;
  
  let email = text.match(emailRegex)?.[0] || '';
  let phone = text.match(phoneRegex)?.[0] || '';
  let linkedin = text.match(linkedinRegex)?.[0] || '';
  let github = text.match(githubRegex)?.[0] || '';
  
  // Try to find name (usually first 1-3 lines)
  let firstName = '';
  let lastName = '';
  let address = '';
  let city = '';
  let state = '';
  let country = '';
  let postalCode = '';

  // Clean lines and find name
  const cleanLines = lines.filter(line => {
    const l = line.trim();
    return l.length > 0 && 
           !l.match(emailRegex) && 
           !l.match(phoneRegex) &&
           !l.match(linkedinRegex) &&
           !l.match(githubRegex);
  });

  // Try to find name (first line that looks like a name)
  for (const line of cleanLines) {
    const words = line.split(' ').filter(w => w.length > 1);
    const excludeKeywords = ['resume', 'cv', 'curriculum', 'vitae', 'portfolio', 'page', 'profile', 'summary', 'contact', 'details', 'application'];
    const hasExclude = words.some(w => excludeKeywords.includes(w.toLowerCase()));
    if (words.length >= 2 && words.length <= 5 && !hasExclude) {
      // Check if it looks like a name (contains letters only)
      const isName = words.every(w => /^[A-Za-z\-'\u00C0-\u017F]+$/.test(w));
      if (isName && !firstName) {
        firstName = words[0] || '';
        lastName = words.slice(1).join(' ') || '';
        console.log(`👤 Found name: ${firstName} ${lastName}`);
        break;
      }
    }
  }

  // Try to find city/country in regex mode
  const pkCities = [
    'karachi', 'lahore', 'islamabad', 'rawalpindi', 'faisalabad', 'peshawar', 
    'multan', 'gujranwala', 'sialkot', 'hyderabad', 'quetta', 'abbottabad', 
    'bahawalpur', 'sargodha', 'sukkur', 'jhang', 'sheikhupura', 'larkana', 
    'gujrat', 'sahiwal', 'wah cantt', 'mardan', 'kasur', 'rahim yar khan'
  ];
  
  const lowerText = text.toLowerCase();
  for (const c of pkCities) {
    const cityRegex = new RegExp(`\\b${c}\\b`, 'i');
    if (cityRegex.test(lowerText)) {
      city = c.charAt(0).toUpperCase() + c.slice(1);
      break;
    }
  }

  if (!city) {
    const commonIntlCities = ['london', 'new york', 'san francisco', 'toronto', 'dubai', 'singapore', 'berlin', 'paris', 'sydney', 'tokyo'];
    for (const c of commonIntlCities) {
      const cityRegex = new RegExp(`\\b${c}\\b`, 'i');
      if (cityRegex.test(lowerText)) {
        city = c.charAt(0).toUpperCase() + c.slice(1);
        break;
      }
    }
  }

  if (/\bpakistan\b/i.test(lowerText) || /\b(pk)\b/i.test(lowerText)) {
    country = 'Pakistan';
  } else if (/\b(usa|united states)\b/i.test(lowerText)) {
    country = 'United States';
  } else if (/\b(uk|united kingdom)\b/i.test(lowerText)) {
    country = 'United Kingdom';
  } else if (/\b(uae|united arab emirates)\b/i.test(lowerText)) {
    country = 'United Arab Emirates';
  } else if (/\bcanada\b/i.test(lowerText)) {
    country = 'Canada';
  }

  // Try to find address
  const addressRegex = /(\d{1,5}\s\w+\s\w+[\s\w,]*)/;
  const addressMatch = text.match(addressRegex);
  if (addressMatch) {
    address = addressMatch[0] || '';
    console.log(`📍 Found address: ${address}`);
  }

  const result = {
    firstName,
    lastName,
    email,
    phone,
    linkedin,
    github,
    address,
    city,
    state,
    country,
    postalCode
  };
  
  console.log('✅ Personal info parsed:', result);
  return result;
};

const parseEducation = (text) => {
  console.log('🔍 Parsing education...');
  
  const education = [];
  const educationKeywords = [
    'university', 'college', 'institute', 'school', 
    'bachelor', 'master', 'phd', 'b.s', 'm.s', 'b.a', 'm.a',
    'bsc', 'msc', 'phd', 'btech', 'mtech', 'bcom', 'mcom',
    'degree', 'diploma', 'certificate'
  ];
  
  const sectionText = extractSectionText(text, 'Education') || text;
  const lines = sectionText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  let currentEducation = null;
  let foundEducation = false;
  let educationSectionStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lowerLine = line.toLowerCase();

    // Check if this line contains education keywords
    const isEducationLine = educationKeywords.some(keyword => lowerLine.includes(keyword));

    if (isEducationLine && !foundEducation) {
      // If we were already building an education, save it
      if (currentEducation && currentEducation.institution) {
        education.push(currentEducation);
      }

      foundEducation = true;
      educationSectionStarted = true;
      
      currentEducation = {
        institution: line,
        degree: '',
        fieldOfStudy: '',
        startDate: null,
        endDate: null,
        current: false,
        gpa: null,
        description: ''
      };

      // Try to extract degree from the same line
      const degreeMatch = line.match(/(Bachelor|Master|PhD|B\.S|M\.S|B\.A|M\.A|BSc|MSc|BTech|MTech|BCom|MCom|MBA|BBA|BFA|MFA)/i);
      if (degreeMatch) {
        currentEducation.degree = degreeMatch[0];
        // Remove degree from institution
        currentEducation.institution = line.replace(degreeMatch[0], '').trim();
        console.log(`🎓 Found degree: ${currentEducation.degree}`);
      }

      // Try to find dates
      const dateRegex = /\b(19|20)\d{2}\b/g;
      const dates = line.match(dateRegex);
      if (dates && dates.length >= 2) {
        currentEducation.startDate = new Date(parseInt(dates[0]), 0, 1);
        currentEducation.endDate = new Date(parseInt(dates[1]), 0, 1);
        console.log(`📅 Found dates: ${dates[0]} - ${dates[1]}`);
      } else if (dates && dates.length === 1) {
        currentEducation.startDate = new Date(parseInt(dates[0]), 0, 1);
        console.log(`📅 Found start date: ${dates[0]}`);
      }

      // Check for "present" or "current"
      if (lowerLine.includes('present') || lowerLine.includes('current')) {
        currentEducation.current = true;
        console.log('🔄 Currently studying');
      }

    } else if (foundEducation && currentEducation) {
      // If we're in education section, try to parse more details
      if (!currentEducation.fieldOfStudy && 
          line.length > 2 && 
          !educationKeywords.some(k => lowerLine.includes(k))) {
        currentEducation.fieldOfStudy = line;
        console.log(`📚 Found field of study: ${line}`);
      } else if (!currentEducation.description && 
                 line.length > 10 && 
                 !line.match(/^\d{4}/) &&
                 !educationKeywords.some(k => lowerLine.includes(k))) {
        currentEducation.description = (currentEducation.description || '') + ' ' + line;
      }

      // Check for GPA
      const gpaMatch = line.match(/GPA[:\s]+(\d\.\d{1,2})/i);
      if (gpaMatch) {
        currentEducation.gpa = parseFloat(gpaMatch[1]);
        console.log(`📊 Found GPA: ${currentEducation.gpa}`);
      }

      // Check for dates in subsequent lines
      const dateRegex = /\b(19|20)\d{2}\b/g;
      const dates = line.match(dateRegex);
      if (dates && dates.length >= 2 && !currentEducation.startDate) {
        currentEducation.startDate = new Date(parseInt(dates[0]), 0, 1);
        currentEducation.endDate = new Date(parseInt(dates[1]), 0, 1);
        console.log(`📅 Found dates: ${dates[0]} - ${dates[1]}`);
      }

      // If we hit a new section (not education), stop
      if (line.match(/^(Experience|Skills|Projects|Certifications|Languages|References|Summary|Objective|Profile|Work|Employment)/i)) {
        foundEducation = false;
        if (currentEducation && currentEducation.institution) {
          education.push(currentEducation);
          console.log(`✅ Added education: ${currentEducation.institution}`);
        }
        currentEducation = null;
        educationSectionStarted = false;
      }
    }
  }

  // Don't forget the last education
  if (currentEducation && currentEducation.institution) {
    education.push(currentEducation);
    console.log(`✅ Added education: ${currentEducation.institution}`);
  }

  // Clean up education entries
  const filteredEducation = education.filter(e => e.institution && e.institution.length > 2);
  console.log(`✅ Found ${filteredEducation.length} education entries`);
  return filteredEducation;
};

/**
 * Parse work experience from text
 */
const parseWorkExperience = (text) => {
  console.log('🔍 Parsing work experience...');
  
  const experiences = [];
  const experienceKeywords = [
    'experience', 'work', 'employment', 'job', 'position', 'role',
    'professional experience', 'work history', 'employment history',
    'career', 'occupation'
  ];
  
  const sectionText = extractSectionText(text, 'Experience') || text;
  const lines = sectionText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  let currentExperience = null;
  let foundExperience = false;
  let experienceSectionStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lowerLine = line.toLowerCase();

    // Check if this line contains experience keywords
    const isExperienceLine = experienceKeywords.some(keyword => lowerLine.includes(keyword));

    if (isExperienceLine && !foundExperience) {
      foundExperience = true;
      experienceSectionStarted = true;
      console.log('💼 Found work experience section');
      continue;
    }

    if (foundExperience) {
      // Check if we've hit a new section
      if (line.match(/^(Education|Skills|Projects|Certifications|Languages|References|Summary|Objective|Profile)/i)) {
        foundExperience = false;
        if (currentExperience && currentExperience.company) {
          experiences.push(currentExperience);
          console.log(`✅ Added experience: ${currentExperience.position} at ${currentExperience.company}`);
        }
        currentExperience = null;
        experienceSectionStarted = false;
        continue;
      }

      // Try to detect company name (often in caps or with certain patterns)
      const companyMatch = line.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Inc|LLC|Corp|Corporation|Company|Ltd|Limited))/);
      const positionMatch = line.match(/^(Senior|Junior|Lead|Principal|Staff|Associate|Developer|Engineer|Manager|Director|Consultant|Analyst|Architect|Designer|Product|Project|Program|Software|Full[-\s]Stack|Frontend|Backend|DevOps|QA|Test|Data|Machine Learning|AI|Cloud|Network|System|Security|DevSecOps)/i);

      if (!currentExperience) {
        // Start new experience
        currentExperience = {
          company: '',
          position: '',
          location: '',
          startDate: null,
          endDate: null,
          current: false,
          description: '',
          achievements: []
        };

        // Try to parse company and position from the same line
        if (companyMatch) {
          currentExperience.company = companyMatch[0];
          console.log(`🏢 Found company: ${currentExperience.company}`);
          const remaining = line.replace(companyMatch[0], '').trim();
          if (remaining.length > 0) {
            currentExperience.position = remaining;
            console.log(`💼 Found position: ${currentExperience.position}`);
          }
        } else if (positionMatch) {
          currentExperience.position = line;
          console.log(`💼 Found position: ${currentExperience.position}`);
        } else {
          // Try to guess if it's a company
          const words = line.split(' ');
          if (words.length >= 2 && words[0].length > 2 && words[0].charAt(0) === words[0].charAt(0).toUpperCase()) {
            currentExperience.company = line;
            console.log(`🏢 Found company: ${currentExperience.company}`);
          }
        }

        // Try to find dates in the line
        const dateRegex = /\b(19|20)\d{2}\b/g;
        const dates = line.match(dateRegex);
        if (dates && dates.length >= 2) {
          currentExperience.startDate = new Date(parseInt(dates[0]), 0, 1);
          currentExperience.endDate = new Date(parseInt(dates[1]), 0, 1);
          console.log(`📅 Found dates: ${dates[0]} - ${dates[1]}`);
        } else if (dates && dates.length === 1) {
          currentExperience.startDate = new Date(parseInt(dates[0]), 0, 1);
          console.log(`📅 Found start date: ${dates[0]}`);
        }

        if (lowerLine.includes('present') || lowerLine.includes('current')) {
          currentExperience.current = true;
          console.log('🔄 Currently working');
        }

      } else {
        // Add to description or achievements
        if (line.length > 10 && !line.match(/^\d{4}/)) {
          // Check if it's an achievement (starts with bullet or dash)
          if (line.match(/^[•\-*]\s/)) {
            const achievement = line.replace(/^[•\-*]\s/, '').trim();
            currentExperience.achievements.push(achievement);
            console.log(`⭐ Found achievement: ${achievement.substring(0, 50)}...`);
          } else {
            currentExperience.description = (currentExperience.description || '') + ' ' + line;
          }
        }

        // Check for dates in subsequent lines
        const dateRegex = /\b(19|20)\d{2}\b/g;
        const dates = line.match(dateRegex);
        if (dates && dates.length >= 2 && !currentExperience.startDate) {
          currentExperience.startDate = new Date(parseInt(dates[0]), 0, 1);
          currentExperience.endDate = new Date(parseInt(dates[1]), 0, 1);
          console.log(`📅 Found dates: ${dates[0]} - ${dates[1]}`);
        }

        if (lowerLine.includes('present') || lowerLine.includes('current')) {
          currentExperience.current = true;
        }
      }
    }
  }

  // Don't forget the last experience
  if (currentExperience && currentExperience.company) {
    experiences.push(currentExperience);
    console.log(`✅ Added experience: ${currentExperience.position} at ${currentExperience.company}`);
  }

  const filteredExperiences = experiences.filter(e => e.company && e.company.length > 2);
  console.log(`✅ Found ${filteredExperiences.length} work experience entries`);
  return filteredExperiences;
};

/**
 * Parse skills from text
 */
const parseSkills = (text) => {
  console.log('🔍 Parsing skills...');
  
  const skills = [];
  const skillsText = extractSectionText(text, 'Skills') || text;
  
  const skillKeywords = [
    'skills', 'technical skills', 'soft skills', 'competencies', 'expertise',
    'core competencies', 'skill set', 'proficiencies', 'technologies',
    'programming languages', 'tools', 'frameworks'
  ];
  
  if (skillsText) {
    const lines = skillsText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (const line of lines) {
      let cleanLine = line;
      // Remove prefixes like "AI & LLM APIs:" or "Backend:"
      if (cleanLine.includes(':')) {
        const parts = cleanLine.split(':');
        if (parts[0].length < 35) {
          cleanLine = parts.slice(1).join(':').trim();
        }
      }
      
      const skillItems = cleanLine.split(/[,;•|/]/)
        .map(s => s.trim())
        .filter(s => s.length > 1 && s.length < 50);
        
      for (const item of skillItems) {
        if (skillKeywords.some(keyword => item.toLowerCase() === keyword)) {
          continue;
        }
        
        const cleanName = item.replace(/^[•\-\*\s]+/, '').replace(/^(Technical|Soft|Language|Other)\s*:?\s*/i, '').trim();
        if (cleanName && cleanName.length > 1 && !skills.some(s => s.name.toLowerCase() === cleanName.toLowerCase())) {
          skills.push({
            name: cleanName,
            level: 'Intermediate',
            category: 'Technical'
          });
        }
      }
    }
  }
  
  // If no skills found, try to find skills in the text
  if (skills.length === 0) {
    console.log('🔍 Searching for skills in full text...');
    const commonSkills = [
      'JavaScript', 'Python', 'Java', 'C++', 'React', 'Node.js', 'Angular',
      'Vue.js', 'TypeScript', 'HTML', 'CSS', 'SQL', 'MongoDB', 'PostgreSQL',
      'MySQL', 'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Git',
      'Agile', 'Scrum', 'Project Management', 'Leadership', 'Communication',
      'Problem Solving', 'Data Analysis', 'Machine Learning', 'AI', 'TensorFlow',
      'PyTorch', 'Flask', 'Django', 'Spring Boot', 'Ruby on Rails', 'PHP',
      'Laravel', 'Swift', 'Kotlin', 'Flutter', 'React Native', 'GraphQL',
      'REST API', 'Microservices', 'CI/CD', 'Jenkins', 'Ansible', 'Terraform'
    ];
    
    for (const skill of commonSkills) {
      const regex = new RegExp(`\\b${skill.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
      if (regex.test(text) && !skills.some(s => s.name.toLowerCase() === skill.toLowerCase())) {
        skills.push({
          name: skill,
          level: 'Intermediate',
          category: 'Technical'
        });
        console.log(`🔧 Found skill: ${skill}`);
      }
    }
  }
  
  console.log(`✅ Found ${skills.length} skills`);
  return skills;
};

/**
 * Parse certifications from text
 */
const parseCertifications = (text) => {
  console.log('🔍 Parsing certifications...');
  
  const certifications = [];
  const certKeywords = [
    'certification', 'certified', 'certificate', 'credential',
    'aws certified', 'google certified', 'microsoft certified',
    'scrum master', 'pmp', 'project management', 'itil'
  ];
  
  const sections = text.split(/\n\s*\n/);
  
  for (const section of sections) {
    const lowerSection = section.toLowerCase();
    if (certKeywords.some(keyword => lowerSection.includes(keyword))) {
      const lines = section.split('\n').filter(l => l.trim());
      
      for (const line of lines) {
        const certName = line.trim();
        if (certName.length > 5 && 
            !certKeywords.some(k => certName.toLowerCase().includes(k)) &&
            certName.length < 100) {
          certifications.push({
            name: certName,
            organization: '',
            issueDate: null,
            expiryDate: null,
            credentialId: '',
            credentialUrl: ''
          });
          console.log(`📜 Found certification: ${certName}`);
        }
      }
    }
  }
  
  console.log(`✅ Found ${certifications.length} certifications`);
  return certifications;
};

/**
 * Parse projects from text
 */
const parseProjects = (text) => {
  console.log('🔍 Parsing projects...');
  
  const projects = [];
  const projectKeywords = ['project', 'portfolio', 'github', 'repository', 'side project'];
  
  const sections = text.split(/\n\s*\n/);
  
  for (const section of sections) {
    const lowerSection = section.toLowerCase();
    if (projectKeywords.some(keyword => lowerSection.includes(keyword))) {
      const lines = section.split('\n').filter(l => l.trim());
      
      if (lines.length >= 2) {
        const name = lines[0]?.trim() || '';
        const description = lines.slice(1).join(' ').trim();
        
        // Try to find technologies
        const techKeywords = [
          'React', 'Node.js', 'Python', 'Java', 'JavaScript', 'HTML', 'CSS',
          'Angular', 'Vue', 'TypeScript', 'Django', 'Flask', 'Spring Boot',
          'Ruby on Rails', 'PHP', 'Laravel', 'SQL', 'MongoDB', 'Firebase',
          'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'GraphQL', 'REST API'
        ];
        const technologies = techKeywords.filter(tech => description.includes(tech));
        
        if (name && name.length > 2) {
          projects.push({
            name: name,
            description: description,
            technologies: technologies,
            startDate: null,
            endDate: null,
            url: '',
            githubUrl: ''
          });
          console.log(`📁 Found project: ${name}`);
        }
      }
    }
  }
  
  console.log(`✅ Found ${projects.length} projects`);
  return projects;
};

/**
 * Parse languages from text
 */
const parseLanguages = (text) => {
  console.log('🔍 Parsing languages...');
  
  const languages = [];
  const languageKeywords = ['languages', 'language proficiency', 'bilingual', 'multilingual'];
  
  // Common languages
  const commonLanguages = [
    'English', 'Spanish', 'French', 'German', 'Chinese', 'Japanese',
    'Arabic', 'Portuguese', 'Russian', 'Italian', 'Dutch', 'Korean',
    'Turkish', 'Hindi', 'Urdu', 'Bengali', 'Punjabi', 'Tamil',
    'Vietnamese', 'Thai', 'Polish', 'Greek', 'Hebrew', 'Swedish',
    'Norwegian', 'Danish', 'Finnish', 'Indonesian', 'Malay'
  ];
  
  const sections = text.split(/\n\s*\n/);
  
  for (const section of sections) {
    const lowerSection = section.toLowerCase();
    if (languageKeywords.some(keyword => lowerSection.includes(keyword))) {
      for (const lang of commonLanguages) {
        if (section.includes(lang)) {
          // Try to determine proficiency
          let proficiency = 'Intermediate';
          if (section.match(new RegExp(`${lang}.*(Native|Fluent|Bilingual)`, 'i'))) {
            proficiency = 'Fluent';
          } else if (section.match(new RegExp(`${lang}.*(Advanced|Professional|Proficient)`, 'i'))) {
            proficiency = 'Intermediate';
          } else if (section.match(new RegExp(`${lang}.*(Basic|Beginner|Elementary)`, 'i'))) {
            proficiency = 'Basic';
          }
          
          languages.push({
            name: lang,
            proficiency: proficiency
          });
          console.log(`🗣️ Found language: ${lang} (${proficiency})`);
        }
      }
    }
  }
  
  // If no languages found, try to find from common languages
  if (languages.length === 0) {
    console.log('🔍 Searching for languages in full text...');
    for (const lang of commonLanguages) {
      if (text.includes(lang)) {
        languages.push({
          name: lang,
          proficiency: 'Intermediate'
        });
        console.log(`🗣️ Found language: ${lang}`);
      }
    }
  }
  
  console.log(`✅ Found ${languages.length} languages`);
  return languages;
};

/**
 * Main parse function for resume
 */
const parseResumePDF = async (filePath, originalName = '') => {
  try {
    console.log('📄 Starting resume parsing for:', filePath);
    
    let ext = path.extname(filePath).toLowerCase();
    if (!ext && originalName) {
      ext = path.extname(originalName).toLowerCase();
    }
    
    let buffer;
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      console.log('🌐 Fetching remote file...');
      const response = await axios.get(filePath, { responseType: 'arraybuffer' });
      buffer = Buffer.from(response.data);
    } else {
      buffer = fs.readFileSync(filePath);
    }
    
    let text = '';
    let imageList = [];
    let isScannedPdf = false;
    
    if (ext === '.pdf') {
      console.log('📄 Parsing PDF file...');
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      text = result.text || '';
      console.log(`✅ Extracted ${text.length} characters from PDF`);
      
      if (!text || text.trim().length < 50) {
        console.log('📸 PDF text is too short. Extracting page images for visual parsing...');
        try {
          const imgResult = await parser.getImage();
          if (imgResult && imgResult.pages) {
            for (const page of imgResult.pages) {
              if (page.images) {
                for (const img of page.images) {
                  if (img.dataUrl) {
                    imageList.push(img.dataUrl);
                  }
                }
              }
            }
          }
          if (imageList.length > 0) {
            isScannedPdf = true;
            console.log(`📸 Successfully extracted ${imageList.length} page images for visual analysis.`);
          }
        } catch (imgErr) {
          console.error('❌ Failed to extract page images from PDF:', imgErr);
        }
      }
    } else if (ext === '.docx' || ext === '.doc') {
      console.log('📄 Parsing Word document...');
      const result = await mammoth.extractRawText({ buffer });
      text = result.value || '';
    } else {
      throw new Error(`Unsupported file format "${ext || 'unknown'}". Please upload PDF or Word document.`);
    }
    
    if (text) {
      text = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        
        // If the line consists of single letters separated by spaces
        // E.g. "E D U C A T I O N" or "W O R K   E X P E R I E N C E"
        const parts = trimmed.split(/\s{2,}/);
        const processedParts = parts.map(part => {
          const isSpaced = /^[a-z0-9&](\s+[a-z0-9&])+\s*$/i.test(part);
          if (isSpaced) {
            return part.replace(/\s+/g, '');
          }
          return part;
        });
        const processedLine = processedParts.join(' ');
        const lowerProcessed = processedLine.toLowerCase();
        
        if (lowerProcessed === 'education') return 'Education';
        if (lowerProcessed.includes('workexperience') || lowerProcessed.includes('experience')) return 'Experience';
        if (lowerProcessed.includes('technicalskills') || lowerProcessed.includes('skills')) return 'Skills';
        if (lowerProcessed === 'projects') return 'Projects';
        if (lowerProcessed.includes('summary') || lowerProcessed.includes('profile') || lowerProcessed.includes('objective')) return 'Summary';
        if (lowerProcessed.includes('certifications') || lowerProcessed.includes('achievements')) return 'Certifications';
        if (lowerProcessed.includes('languages')) return 'Languages';
        
        return processedLine;
      }).join('\n');
    }

    if (!isScannedPdf && (!text || text.trim().length < 50)) {
      console.warn('⚠️ Extracted text is too short, falling back to basic parsing');
      // Don't throw error, return basic structure instead
      return {
        personalInfo: {
          firstName: originalName ? originalName.split('.')[0] : 'Resume',
          lastName: '',
          email: '',
          phone: '',
          address: '',
          city: '',
          state: '',
          country: '',
          postalCode: '',
          linkedin: '',
          github: '',
          portfolio: ''
        },
        professionalSummary: {
          title: 'Professional',
          summary: 'Experienced professional with strong background.',
          experienceLevel: 'Mid Level'
        },
        education: [],
        skills: [],
        workExperience: [],
        certifications: [],
        projects: [],
        languages: [],
        rawText: text
      };
    }
    
    console.log('📝 Text length to analyze:', text.length);
    
    // Check if OpenAI API key is set for advanced parsing
    if (process.env.OPENAI_API_KEY) {
      try {
        console.log('🤖 Parsing resume using OpenAI gpt-4o-mini...');
        const client = getOpenAI();
        const systemPrompt = `You are an expert ATS Resume Parsing engine. Your task is to analyze the raw text or images extracted from a resume document and convert it into a structured JSON object matching the JSON schema provided.

Return ONLY a valid JSON object matching the schema below. Do not wrap in markdown or add explanations.

IMPORTANT RULES:
1. Extract information EXACTLY as written in the resume text/images
2. Do not add fictional information
3. If a field cannot be determined, use empty string or null
4. For dates, use YYYY-MM-DD format or null if unclear
5. Be conservative - only include information you can confidently extract

Schema:
{
  "personalInfo": {
    "firstName": "string",
    "lastName": "string", 
    "email": "string",
    "phone": "string",
    "address": "string",
    "city": "string",
    "state": "string",
    "country": "string",
    "postalCode": "string",
    "linkedin": "string (URL or username)",
    "github": "string (URL or username)",
    "portfolio": "string (URL)"
  },
  "professionalSummary": {
    "title": "string (job title or professional role)",
    "summary": "string (professional summary or objective)",
    "experienceLevel": "Entry Level | Mid Level | Senior Level | Executive"
  },
  "education": [
    {
      "institution": "string",
      "degree": "string",
      "fieldOfStudy": "string",
      "startDate": "YYYY-MM-DD or null",
      "endDate": "YYYY-MM-DD or null", 
      "current": boolean,
      "gpa": number or null,
      "description": "string"
    }
  ],
  "workExperience": [
    {
      "company": "string",
      "position": "string",
      "location": "string",
      "startDate": "YYYY-MM-DD or null",
      "endDate": "YYYY-MM-DD or null",
      "current": boolean,
      "description": "string",
      "achievements": ["string"]
    }
  ],
  "skills": [
    {
      "name": "string",
      "level": "Beginner | Intermediate | Advanced | Expert",
      "category": "Technical | Soft Skills | Language | Other"
    }
  ],
  "projects": [
    {
      "name": "string",
      "description": "string",
      "technologies": ["string"],
      "startDate": "YYYY-MM-DD or null",
      "endDate": "YYYY-MM-DD or null",
      "url": "string (URL)",
      "githubUrl": "string (URL)"
    }
  ],
  "certifications": [
    {
      "name": "string",
      "organization": "string",
      "issueDate": "YYYY-MM-DD or null",
      "expiryDate": "YYYY-MM-DD or null",
      "credentialId": "string",
      "credentialUrl": "string (URL)"
    }
  ],
  "languages": [
    {
      "name": "string",
      "proficiency": "Native | Fluent | Intermediate | Basic"
    }
  ]
}`;

        let userContent;
        if (isScannedPdf && imageList.length > 0) {
          console.log(`📸 Visual parsing mode: passing ${imageList.length} page images to OpenAI...`);
          userContent = [
            { type: 'text', text: 'Please analyze the following resume page image(s) and extract the structured information matching the requested JSON schema.' },
            ...imageList.map(dataUrl => ({
              type: 'image_url',
              image_url: { url: dataUrl }
            }))
          ];
        } else {
          userContent = `Resume Text to Parse:\n\n${text.substring(0, 8000)}`;
        }

        const completion = await client.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          temperature: 0.1,
          max_tokens: 4000,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ],
          response_format: { type: 'json_object' }
        });

        const rawJson = completion.choices[0]?.message?.content || '{}';
        console.log('🤖 OpenAI raw response length:', rawJson.length);
        
        let parsed;
        try {
          parsed = JSON.parse(rawJson);
        } catch (jsonError) {
          console.error('❌ Failed to parse OpenAI JSON response:', jsonError);
          throw new Error('AI parsing returned invalid JSON');
        }
        
        console.log('✅ OpenAI resume parsing successful');
        
        // Ensure default structures are present and validate data
        parsed.personalInfo = parsed.personalInfo || {};
        parsed.professionalSummary = parsed.professionalSummary || {};
        parsed.education = Array.isArray(parsed.education) ? parsed.education : [];
        parsed.workExperience = Array.isArray(parsed.workExperience) ? parsed.workExperience : [];
        parsed.skills = Array.isArray(parsed.skills) ? parsed.skills : [];
        parsed.projects = Array.isArray(parsed.projects) ? parsed.projects : [];
        parsed.certifications = Array.isArray(parsed.certifications) ? parsed.certifications : [];
        parsed.languages = Array.isArray(parsed.languages) ? parsed.languages : [];
        
        // Validate and clean data
        if (!parsed.personalInfo.firstName && !parsed.personalInfo.lastName) {
          // Try to extract name from text
          const nameMatch = text.match(/^([A-Z][a-z]+ [A-Z][a-z]+)/m);
          if (nameMatch) {
            const [firstName, ...lastName] = nameMatch[1].split(' ');
            parsed.personalInfo.firstName = firstName;
            parsed.personalInfo.lastName = lastName.join(' ');
          }
        }
        
        // Store raw text for debugging
        parsed.rawText = text.substring(0, 2000);

        // Deduplicate skills
        if (parsed.skills && Array.isArray(parsed.skills)) {
          const seen = new Set();
          parsed.skills = parsed.skills.filter(skill => {
            if (!skill.name) return false;
            const norm = skill.name.toLowerCase().trim().replace(/[\.\-\s]/g, '');
            if (seen.has(norm)) return false;
            seen.add(norm);
            return true;
          });
        }

        return parsed;
      } catch (aiError) {
        console.error('❌ OpenAI resume parsing failed, falling back to regex parser:', aiError);
        // Continue with fallback parsing instead of throwing
      }
    } else {
      console.log('ℹ️ OpenAI API key not configured, using fallback parser');
    }

    // Fallback: Parse different sections manually using regex rules
    console.log('🔍 Running fallback regex parsing...');
    const personalInfo = parsePersonalInfo(text);
    const education = parseEducation(text);
    const workExperience = parseWorkExperience(text);
    const skills = parseSkills(text);
    const certifications = parseCertifications(text);
    const projects = parseProjects(text);
    const languages = parseLanguages(text);
    
    // Create professional summary from first few lines
    const lines = text.split('\n').filter(l => l.trim());
    let summary = '';
    let title = '';
    
    // Try to find a summary section
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      if (line.includes('summary') || line.includes('objective') || line.includes('profile')) {
        const summaryLines = [];
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          if (lines[j].match(/^(Education|Experience|Skills|Projects|Certifications|Languages|References)/i)) {
            break;
          }
          if (lines[j].trim().length > 10) {
            summaryLines.push(lines[j]);
          }
        }
        summary = summaryLines.join(' ').trim();
        break;
      }
    }
    
    // Try to find professional title
    if (workExperience.length > 0 && workExperience[0].position) {
      title = workExperience[0].position;
    } else if (personalInfo.firstName && personalInfo.lastName) {
      title = `${personalInfo.firstName} ${personalInfo.lastName}`;
    } else {
      title = 'Professional';
    }
    
    // Determine experience level based on work history
    let experienceLevel = 'Mid Level';
    if (workExperience.length === 0) {
      experienceLevel = 'Entry Level';
    } else if (workExperience.length >= 3) {
      experienceLevel = 'Senior Level';
    }
    
    if (!summary && lines.length > 3) {
      // Take first non-header line as summary
      for (let i = 1; i < Math.min(lines.length, 10); i++) {
        const line = lines[i].trim();
        if (line.length > 20 && 
            !line.match(/^(Education|Experience|Skills|Projects|Certifications|Languages|References|Email|Phone)/i)) {
          summary = line;
          break;
        }
      }
    }
    
    if (!summary) {
      summary = 'Experienced professional with a strong background in the industry.';
    }
    
    const result = {
      personalInfo,
      professionalSummary: {
        title: title,
        summary: summary,
        experienceLevel: experienceLevel
      },
      education,
      skills,
      workExperience,
      certifications,
      projects,
      languages,
      rawText: text.substring(0, 2000)
    };
    
    // Deduplicate skills
    if (result.skills && Array.isArray(result.skills)) {
      const seen = new Set();
      result.skills = result.skills.filter(skill => {
        if (!skill.name) return false;
        const norm = skill.name.toLowerCase().trim().replace(/[\.\-\s]/g, '');
        if (seen.has(norm)) return false;
        seen.add(norm);
        return true;
      });
    }

    console.log('✅ Fallback resume parsing completed successfully');
    console.log(`📊 Parsed: ${personalInfo.firstName ? 'Name ✓' : 'Name ✗'} | Skills: ${result.skills.length} | Experience: ${workExperience.length} | Education: ${education.length}`);
    
    return result;
  } catch (error) {
    console.error('❌ Error parsing resume:', error);
    // Return basic structure instead of throwing error
    return {
      personalInfo: {
        firstName: originalName ? originalName.split('.')[0] : '',
        lastName: '',
        email: '',
        phone: '',
        address: '',
        city: '',
        state: '',
        country: '',
        postalCode: '',
        linkedin: '',
        github: '',
        portfolio: ''
      },
      professionalSummary: {
        title: 'Professional',
        summary: 'Resume parsing encountered an error. Please review and update your information.',
        experienceLevel: 'Mid Level'
      },
      education: [],
      skills: [],
      workExperience: [],
      certifications: [],
      projects: [],
      languages: [],
      rawText: '',
      parseError: error.message
    };
  }
};

module.exports = { parseResumePDF };