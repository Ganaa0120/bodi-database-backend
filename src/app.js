'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const env = require('./config/env');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const companyRoutes = require('./routes/companyRoutes');
const departmentTemplateRoutes = require('./routes/departmentTemplateRoutes');
const departmentRoutes = require('./routes/departmentRoutes');
const formSubmissionRoutes = require('./routes/formSubmissionRoutes');
const editRequestRoutes = require('./routes/editRequestRoutes');
const errorHandler = require('./middleware/errorHandler');
const analyticsRoutes = require('./routes/analyticsRoutes');

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: env.corsOrigins.length > 0 ? env.corsOrigins : false,
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/department-templates', departmentTemplateRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/form-submissions', formSubmissionRoutes);
app.use('/api/edit-requests', editRequestRoutes);
app.use('/api/analytics', analyticsRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Route олдсонгүй.' });
});

app.use(errorHandler);

module.exports = app;