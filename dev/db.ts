import postgres from 'postgres';
import path from 'node:path';

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { DB_USER, DB_PASS } = process.env;

const sql = postgres(`postgres://${DB_USER}:${DB_PASS}@localhost:5432/`, { /* options */ }); // will use psql environment variables

export default sql;
