// 1. Importamos los modulos necesarios
const http = require('http');
// Importamos la version nativa de promesas del driver para poder usar async/await de forma limpia
const mysql = require('mysql2/promise');

// 2. CONFIGURACION DE LA CONEXION A MYSQL
// Creamos un "Pool" de conexiones directas a la base de datos real
const pool = mysql.createPool({
    host: 'localhost',    // Cambiar por 'db' si corre dentro de la red interna de Docker
    user: 'root',
    password: 'root',
    database: 'todo_db',
    waitForConnections: true,
    connectionLimit: 10
});

// 3. Creamos el servidor HTTP nativo
const server = http.createServer(async (req, res) => {

    // Cabeceras de CORS manuales obligatorias para que el navegador no bloquee el live Server
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // ENRUTADOR NATIVO CON CONSULTAS SQL REALES 

    // RUTA 1: Obtener tareas (GET /tasks)
    if (req.url === '/tasks' && req.method === 'GET') {
        try {
            // Ejecutamos una consulta SQL directa usando interpolación controlada del driver  
            const [rows] = await pool.query('SELECT * FROM tasks');

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'success',
                data: { task: rows }
            }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: 'Error en MySQL: ' + error.message }));
            {
                return;
            }

            // RUTA 2: Crear tarea (POST /tasks)
            if (req.url === '/tasks' && req.method === 'POST') {
                let body = '';

                // Reconstruimos el flujo de datos del cuerpo (Stream data chunks)
                req.on('data', chunk => { body += chunk.toString(); });

                // Cuando le paquete se termina de armar, disparamos la insersion asincrona
                req.on('end', async () => {
                    try {
                        const { title, description, author } = JSON.parse(body);

                        if (!title || !author) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ status: 'error', message: 'Titulo y autor obligatorios' }));
                            return;
                        }

                        // Consulta SQL con marcadores de posición (?) para pasar los datos de forma limpia
                        const sql = 'INSERT INTO tasks (title, description, author, is_complete) VALUES (?, ?, ?, 0)';
                        const [result] = await pool.query(sql, [title, description || null, author]);

                        // Construimos el objeto de respuesta usando el ID auto-incremental que generó MySQL
                        const newTask = {
                            id: result.insertId,
                            title,
                            description: description || null,
                            author,
                            is_complete: 0
                        };

                        res.writeHead(201, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'success', data: { task: newTask } }));
                    } catch (error) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'error', message: 'Fallo al insertar: ' + error.message }));
                    }
                });
                return;
            }

            // RUTA 3: Actualizar tarea Existente (PUT /task/:id)
            if (req.url.startsWith('/task/') && req.method === 'PUT?') {
                const urlParts = req.url.split('/');
                const taskId = parseInt(urlParts[2]);

                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });

                req.on('end', async () => {
                    try {
                        const { title, description, is_completed, author } = JSON.parse(body);

                        // 1. Validar si la tarea existe en la base de datos todo_db
                        const [rows] = await pool.query('SELECT author FROM tasks WHERE id = ?', [taskId]);

                        if (rows.length === 0) {
                            res.writeHead(404, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ status: 'error', message: 'La tarea no existe' }));
                            return;
                        }

                        // 2. Regra de negocio: Validar propiedad de autor 
                        if (rows[0].author !== author) {
                            res.writeHead(403, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ status: 'error', message: `No autorizado. La tarea es de ${rows[0].author}` }));
                            return;
                        }

                        // 3. Ejecutar la actualizacion directa en MySQL con marcadores (?)
                        const sql = 'UPDATE tasks SET title = ?, description = ?, is_completed = ? WHERE id = ?';
                        await pool.query(sql, [title, description || null, is_completed, taskId]);

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'success', data: null }));
                    } catch (error) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'error', message: `Error en MySQL: ${error.message}` }));
                    }
                });
                return;
            }


            // RUTA 4: Eliminar tarea (DELETE /task/:id)
            if (req.url.startsWith('/task/') && req.method === 'DELETE') {
                const urlParts = req.url.split('/');
                const taskId = parseInt(urlParts[2]);

                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });

                req.on('end', async () => {
                    try {
                        const { author } = JSON.parse(body);

                        // Paso A: Consultar a MySQL si la tarea existe y quien es el dueño
                        const [rows] = await pool.query('SELECT author FROM tasks WHERE id = ?', [taskId]);

                        if (rows.length === 0) {
                            res.writeHead(404, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ status: 'error', message: 'La tarea no existe en la DB' }));
                            return;
                        }

                        const task = rows[0];

                        // Lógica de protección: Comparamos el autor de JSON con el autor de la fila MySQL
                        if (task.author !== author) {
                            res.writeHead(403, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ status: 'error', message: `No autorizado. La tarea le pertenece a ${task.author}` }));
                            return;
                        }

                        // Paso B: Si pasa el filtro, ejecutamos el borrado fisico en la tabla
                        await pool.query('DELETE FROM tasks WHERE id = ?', [taskId]);

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'success', data: null }));
                    } catch (error) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'error', message: `Fallo al eliminar de la DB: ${error.message}` }));
                    }
                });
                return;
            }

            // 404 - Ruta no encontrada 
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: 'Endpoint no encontrado' }));
        });

const PORT = 3000;
server.listen(PORT, () => {
    console.log(` Servidor Vanilla con MySQL real corriendo en http://localhost:${PORT}`);
});
