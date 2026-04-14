const express = require('express');
const router = express.Router();
const Course = require('../models/Course');
const User = require('../models/User');
const auth = require('../middleware/auth.middleware');

// ==================== PUBLIC COURSE ROUTES (No Auth Required for viewing) ====================

// Get all active courses (main endpoint for browsing)
router.get('/', async (req, res) => {
  try {
    const courses = await Course.find({ isActive: true }).sort({ createdAt: -1 });
    
    // Transform courses to include full image URLs
    const transformedCourses = courses.map(course => ({
      ...course.toObject(),
      // Ensure image URL is absolute
      image: course.image || getDefaultImage(course.category)
    }));
    
    res.json({
      success: true,
      count: transformedCourses.length,
      courses: transformedCourses
    });
  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching courses', 
      error: error.message 
    });
  }
});

// Get all courses (alternative endpoint for frontend - matches frontend call)
router.get('/course', async (req, res) => {
  try {
    const courses = await Course.find({ isActive: true }).sort({ createdAt: -1 });
    
    const transformedCourses = courses.map(course => ({
      ...course.toObject(),
      image: course.image || getDefaultImage(course.category)
    }));
    
    res.json({
      success: true,
      count: transformedCourses.length,
      courses: transformedCourses
    });
  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching courses', 
      error: error.message 
    });
  }
});

// Get course by ID
router.get('/:id', async (req, res) => {
  try {
    const course = await Course.findOne({ id: req.params.id, isActive: true });
    if (!course) {
      return res.status(404).json({ 
        success: false, 
        message: 'Course not found' 
      });
    }
    
    res.json({
      success: true,
      course: {
        ...course.toObject(),
        image: course.image || getDefaultImage(course.category)
      }
    });
  } catch (error) {
    console.error('Error fetching course:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching course', 
      error: error.message 
    });
  }
});

// Get courses by category
router.get('/category/:category', async (req, res) => {
  try {
    const courses = await Course.find({ 
      category: req.params.category, 
      isActive: true 
    }).sort({ createdAt: -1 });
    
    const transformedCourses = courses.map(course => ({
      ...course.toObject(),
      image: course.image || getDefaultImage(course.category)
    }));
    
    res.json({
      success: true,
      count: transformedCourses.length,
      courses: transformedCourses
    });
  } catch (error) {
    console.error('Error fetching courses by category:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching courses', 
      error: error.message 
    });
  }
});

// ==================== AUTHENTICATED COURSE ROUTES ====================

// Get enrolled courses for a user
router.get('/user/enrolled', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }
    
    // Get full course details for each enrolled course
    const enrolledCourses = [];
    for (const enrollment of user.enrolledCourses || []) {
      const course = await Course.findOne({ id: enrollment.courseId, isActive: true });
      if (course) {
        enrolledCourses.push({
          ...course.toObject(),
          image: course.image || getDefaultImage(course.category),
          userProgress: {
            percentage: enrollment.progress || 0,
            currentModule: enrollment.currentModule,
            lastAccessed: enrollment.lastAccessed,
            completed: enrollment.completed || false
          }
        });
      }
    }
    
    res.json({
      success: true,
      courses: enrolledCourses
    });
  } catch (error) {
    console.error('Error fetching enrolled courses:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching enrolled courses', 
      error: error.message 
    });
  }
});

// Update course progress
router.put('/:courseId/progress', auth, async (req, res) => {
  try {
    const { progress, currentModule, completed, lessonId } = req.body;
    
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }
    
    // Initialize enrolledCourses if it doesn't exist
    if (!user.enrolledCourses) {
      user.enrolledCourses = [];
    }
    
    const enrollmentIndex = user.enrolledCourses.findIndex(
      e => e.courseId === req.params.courseId
    );
    
    if (enrollmentIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: 'Course not found in user enrollments' 
      });
    }
    
    // Update progress
    user.enrolledCourses[enrollmentIndex].progress = progress;
    user.enrolledCourses[enrollmentIndex].currentModule = currentModule;
    user.enrolledCourses[enrollmentIndex].lastAccessed = new Date();
    
    if (completed !== undefined) {
      user.enrolledCourses[enrollmentIndex].completed = completed;
    }
    
    // If lessonId provided, update lesson completion status
    if (lessonId) {
      // You can add logic here to track individual lesson completion
      if (!user.enrolledCourses[enrollmentIndex].completedLessons) {
        user.enrolledCourses[enrollmentIndex].completedLessons = [];
      }
      if (!user.enrolledCourses[enrollmentIndex].completedLessons.includes(lessonId)) {
        user.enrolledCourses[enrollmentIndex].completedLessons.push(lessonId);
      }
    }
    
    await user.save();
    
    res.json({
      success: true,
      message: 'Progress updated successfully',
      progress: user.enrolledCourses[enrollmentIndex]
    });
  } catch (error) {
    console.error('Error updating progress:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error updating progress', 
      error: error.message 
    });
  }
});

// Enroll in a course
router.post('/:courseId/enroll', auth, async (req, res) => {
  try {
    const course = await Course.findOne({ id: req.params.courseId, isActive: true });
    if (!course) {
      return res.status(404).json({ 
        success: false, 
        message: 'Course not found' 
      });
    }
    
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }
    
    // Initialize enrolledCourses if it doesn't exist
    if (!user.enrolledCourses) {
      user.enrolledCourses = [];
    }
    
    // Check if already enrolled
    const alreadyEnrolled = user.enrolledCourses.some(
      e => e.courseId === req.params.courseId
    );
    
    if (alreadyEnrolled) {
      return res.status(400).json({ 
        success: false, 
        message: 'Already enrolled in this course' 
      });
    }
    
    // Enroll user
    user.enrolledCourses.push({
      courseId: req.params.courseId,
      progress: 0,
      currentModule: course.modules[0]?.id || null,
      enrolledAt: new Date(),
      completed: false,
      completedLessons: []
    });
    
    // Increment enrolled count
    course.enrolledCount += 1;
    await course.save();
    await user.save();
    
    res.json({
      success: true,
      message: 'Successfully enrolled in course'
    });
  } catch (error) {
    console.error('Error enrolling in course:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error enrolling in course', 
      error: error.message 
    });
  }
});

// Helper function to get default images based on category
function getDefaultImage(category) {
  const defaultImages = {
    ds: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800",
    ai: "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=800",
    fs: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=800",
    cs: "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=800",
    default: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=800"
  };
  return defaultImages[category] || defaultImages.default;
}

module.exports = router;