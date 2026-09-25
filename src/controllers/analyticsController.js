'use strict';

const { query } = require('../config/db');

const VALID_STATUSES = ['pending', 'accepted', 'rejected'];

function buildWhere(req) {
  const { role, companyId } = req.auth;
  const conditions = ['fs.deleted_at IS NULL'];
  const params = [];

  if (role === 'company') {
    params.push(companyId);
    conditions.push(`fs.company_id = $${params.length}`);
  } else if (req.query.companyId) {
    params.push(req.query.companyId);
    conditions.push(`fs.company_id = $${params.length}`);
  }

  if (req.query.departmentId) {
    params.push(req.query.departmentId);
    conditions.push(`fs.department_id = $${params.length}`);
  }
  if (req.query.status && VALID_STATUSES.includes(req.query.status)) {
    params.push(req.query.status);
    conditions.push(`fs.status = $${params.length}`);
  }
  if (req.query.from) {
    params.push(req.query.from);
    conditions.push(`fs.created_at >= $${params.length}`);
  }
  if (req.query.to) {
    params.push(req.query.to);
    conditions.push(`fs.created_at <= $${params.length}`);
  }

  return { where: conditions.join(' AND '), params };
}

async function analytics(req, res, next) {
  try {
    const { where, params } = buildWhere(req);
    const { role, companyId } = req.auth;

    const totalsByStatus = await query(
      `SELECT fs.status, COUNT(*)::int AS count FROM form_submissions fs WHERE ${where} GROUP BY fs.status`,
      params
    );

    const overTime = await query(
      `SELECT to_char(date_trunc('month', fs.created_at), 'YYYY-MM') AS period, COUNT(*)::int AS count
       FROM form_submissions fs WHERE ${where} GROUP BY period ORDER BY period`,
      params
    );

    // super_admin компани сонгоогүй бол компаниар, бусад тохиолдолд хэлтсээр бүлэглэнэ.
    let byGroup, groupLabel;
    if (role === 'super_admin' && !req.query.companyId) {
      groupLabel = 'company';
      byGroup = await query(
        `SELECT c.id AS group_id, c.name AS group_name, COUNT(*)::int AS count
         FROM form_submissions fs JOIN companies c ON c.id = fs.company_id
         WHERE ${where} GROUP BY c.id, c.name ORDER BY count DESC`,
        params
      );
    } else {
      groupLabel = 'department';
      byGroup = await query(
        `SELECT d.id AS group_id, d.name AS group_name, COUNT(*)::int AS count
         FROM form_submissions fs JOIN departments d ON d.id = fs.department_id
         WHERE ${where} GROUP BY d.id, d.name ORDER BY count DESC`,
        params
      );
    }

    let companies = [];
    if (role === 'super_admin') {
      const r = await query(`SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY name`);
      companies = r.rows;
    }

    let deptQuery = `SELECT id, name, company_id FROM departments WHERE deleted_at IS NULL`;
    const deptParams = [];
    if (role === 'company') {
      deptParams.push(companyId);
      deptQuery += ` AND company_id = $1`;
    } else if (req.query.companyId) {
      deptParams.push(req.query.companyId);
      deptQuery += ` AND company_id = $1`;
    }
    const departments = await query(deptQuery + ' ORDER BY name', deptParams);

    return res.status(200).json({
      totalsByStatus: totalsByStatus.rows,
      overTime: overTime.rows,
      byGroup: byGroup.rows,
      groupLabel,
      filters: { companies, departments: departments.rows },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { analytics };