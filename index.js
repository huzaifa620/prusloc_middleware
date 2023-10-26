const express = require('express');
require('dotenv').config();
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');
const cors = require('cors');
const { EventEmitter } = require('events');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

const corsOptions = {
  origin: '*',
};

app.use(cors(corsOptions));

const statusEmitter = new EventEmitter();

const sendStatusUpdates = (res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send status updates to the client when they are available
  statusEmitter.on('update', async (update) => {
    const connection = await mysql.createConnection(dbConfig);
    await connection.execute('UPDATE scripts_status SET status = ? WHERE script = ?', [update.status, update.script]);
    connection.end();
    res.write(`data: ${JSON.stringify(update)}\n\n`);
  });
};

app.get('/status-updates', (req, res) => {
  sendStatusUpdates(res);
});

app.post('/webhook', async (req, res) => {
  const dataFromFlask = req.body;
  console.log(dataFromFlask);
  statusEmitter.emit('update', dataFromFlask);

  res.json({ message: 'Data received successfully' });
});

const dbConfig = {
  host: process.env.mysql_db_host,
  user: process.env.mysql_db_user,
  password: process.env.mysql_db_password,
  database: 'data',
};

app.get('/api/data/:tableName', async (req, res) => {
  try {
    const { tableName } = req.params;
    const connection = await mysql.createConnection(dbConfig);
    const [rows] = await connection.execute(`SELECT * FROM ${tableName}`);
    connection.end();

    res.json(rows);
  } catch (error) {
    console.error('Error fetching data from the database:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.put('/api/status/:scriptName', async (req, res) => {
  const { scriptName } = req.params;

  try {
    const connection = await mysql.createConnection(dbConfig);
    await connection.execute('UPDATE scripts_status SET status = ? WHERE script = ?', ['running', scriptName]);

    connection.end();
    res.status(200).json({ message: 'status altered!' })
  }
  catch {
    res.status(404).json({ error: `Variable ${scriptName} not found` });
  }
});

app.post('/api/signin', async (req, res) => {
  const { username, password } = req.body;

  try {
    const connection = await mysql.createConnection(dbConfig);
    const [rows] = await connection.execute('SELECT * FROM users WHERE username = ?', [username]);

    if (rows.length === 1) {
      const user = rows[0];
      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (isPasswordValid) {
        // Password is correct, generate a JWT token and send user info
        const token = jwt.sign({ username }, 'your-secret-key', { expiresIn: '30d' });
        res.status(200).json({ token, username });
        return;
      }
    }
    
    // Invalid credentials
    res.status(401).json({ error: 'Invalid credentials' });
  } catch (error) {
    console.error('Error during sign-in:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


app.post('/api/delete-listings', async (req, res) => {
  try {
    const params = req.body;
    const tableName = params['tableName'];
    const records = params['recordsToDelete'];
    const selectedDate = params['selectedDate'];
    const username = req.body['userName'];

    if (username !== 'adminangel') {
      return res.status(401).json({ error: 'Unauthorized: Only admin can perform deletions' });
    }

    if (!tableName) {
      return res.status(400).json({ error: 'Table name is required' });
    }

    if (!records && !selectedDate) {
      return res.status(400).json({ error: 'Either recordsToDelete or selectedDate is required' });
    }

    const connection = await mysql.createConnection(dbConfig);

    await connection.beginTransaction();

    try {
      if (records) {

        if (!Array.isArray(records) || records.length === 0) {
          return res.status(400).json({ error: 'Invalid input' });
        }

        for (const record of records) {

          if (tableName === 'tnledger_courts' || tableName === 'tn_public_notice_probate_notice') {
            await connection.execute(
              `DELETE FROM ${tableName} WHERE id = ?`,
              [record]
            );
          } else {
            if (tableName === 'tn_courts') {
              await connection.execute(
                `DELETE FROM ${tableName} WHERE url = ?`,
                [record]
              );
            } else {
              await connection.execute(
                `DELETE FROM ${tableName} WHERE tdn_no = ?`,
                [record]
              );
            }
          }
        }
      } else if (selectedDate) {
        const formattedDate = tableName === 'tn_public_notice_probate_notice' ? selectedDate : selectedDate + 'T00:00:00.000Z';
        await connection.execute(
          `DELETE FROM ${tableName} WHERE date_ran = ?`,
          [formattedDate]
        );
      }


      await connection.commit();
      connection.end();
      res.status(200).json({ message: 'Records deleted successfully' });
    } catch (error) {

      await connection.rollback();
      connection.end();
      throw error;
    }
  } catch (error) {
    console.error('Error deleting records:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


// For User Accounts

app.post('/api/create-user', async (req, res) => {
  try {
    const { username, password, tasks } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Check if the username already exists
    const connection = await mysql.createConnection(dbConfig);
    const [existingUsers] = await connection.execute('SELECT * FROM users WHERE username = ?', [username]);
    connection.end();

    if (existingUsers.length > 0) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const insertConnection = await mysql.createConnection(dbConfig);

    await insertConnection.execute('INSERT INTO users (username, password, tasks) VALUES (?, ?, ?)', [
      username,
      hashedPassword,
      tasks || '',
    ]);

    insertConnection.end();

    res.status(201).json({ message: 'User created successfully' });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


app.put('/api/edit-user/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const { tasks } = req.body;

    const connection = await mysql.createConnection(dbConfig);
    const [existingUsers] = await connection.execute('SELECT * FROM users WHERE id = ?', [userId]);
    connection.end();

    if (existingUsers.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updateConnection = await mysql.createConnection(dbConfig);

    await updateConnection.execute('UPDATE users SET tasks = ? WHERE id = ?', [tasks || '', userId]);

    updateConnection.end();

    res.status(200).json({ message: 'User updated successfully' });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


app.delete('/api/delete-user/:id', async (req, res) => {
  try {
    const userId = req.params.id;

    const connection = await mysql.createConnection(dbConfig);
    const [existingUsers] = await connection.execute('SELECT * FROM users WHERE id = ?', [userId]);
    connection.end();

    if (existingUsers.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const deleteConnection = await mysql.createConnection(dbConfig);

    await deleteConnection.execute('DELETE FROM users WHERE id = ?', [userId]);

    deleteConnection.end();

    res.status(200).json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


app.get('/', (req, res) => {
    res.json({ message: 'Hello, World!' });
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});