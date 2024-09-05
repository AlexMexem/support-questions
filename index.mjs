import express from "express";
import multer from "multer";
import { Low, JSONFile } from "lowdb";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs/promises";
import { Parser } from "json2csv"; // Import json2csv for CSV conversion
import basicAuth from "basic-auth"; // Import basic-auth for simple password protection
import Papa from "papaparse"; // Import Papa parse

const app = express();
const upload = multer({ dest: "uploads/" });
const port = 3000;

// Middleware to parse incoming requests with a larger size limit
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

// Simple password protection
const USERNAME = "admin"; // Set your username here
const PASSWORD = "password123"; // Set your password here

// Middleware to protect all routes
app.use((req, res, next) => {
  const credentials = basicAuth(req);

  if (
    !credentials ||
    credentials.name !== USERNAME ||
    credentials.pass !== PASSWORD
  ) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Restricted Area"');
    return res
      .status(401)
      .send("Access denied. Please provide valid credentials.");
  }

  next();
});

// Serve static files from the public directory
app.use(express.static(path.join(process.cwd(), "public")));

// Ensure the database directory exists
const dbDirectory = path.join(process.cwd(), "databases");

try {
  await fs.access(dbDirectory);
} catch (error) {
  if (error.code === "ENOENT") {
    await fs.mkdir(dbDirectory);
  } else {
    console.error("Error accessing directory:", error);
  }
}

// Function to get a database instance for a specific file
const getDatabase = async (file) => {
  const adapter = new JSONFile(path.join(dbDirectory, `${file}.json`));
  const db = new Low(adapter);
  await db.read();
  db.data ||= { questions: [], progress: {} };
  return db;
};

// Route to handle file upload and CSV parsing
app.post("/upload", upload.single("csvfile"), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).send("No file uploaded.");
  }

  const fileName = path.basename(
    file.originalname,
    path.extname(file.originalname)
  );

  try {
    const data = await fs.readFile(file.path, "utf8");
    const results = Papa.parse(data, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
    });

    // Check for errors during parsing
    if (results.errors.length > 0) {
      console.error("CSV Parsing Errors:", results.errors);
      return res
        .status(400)
        .send(
          `CSV parsing error on row ${results.errors[0].row}: ${results.errors[0].message}`
        );
    }

    // Initialize checkedComplete and canDownload to false
    const questions = results.data.map((question, index) => ({
      id: index + 1, // Unique ID starting from 1
      ...question,
      checkedComplete: false, // Initialize as false
      canDownload: false, // Initialize canDownload as false
    }));

    const db = await getDatabase(fileName);
    db.data.questions = questions;
    await db.write();

    await fs.unlink(file.path); // Delete the temporary uploaded file
    res.send(`File ${fileName} uploaded and data parsed successfully.`);
  } catch (err) {
    console.error("Error processing file:", err.message);
    res.status(500).send("Error processing file.");
  }
});

// Route to fetch and export only completed and marked-for-download questions as CSV
app.get("/export-csv", async (req, res) => {
  const file = req.query.file;
  const db = await getDatabase(file);

  if (!db.data.questions || db.data.questions.length === 0) {
    return res.status(404).json({ message: "No data available." });
  }

  // Filter out only the questions that are both completed and marked for download
  const exportableQuestions = db.data.questions.filter(
    (q) => q.checkedComplete && q.canDownload
  );

  if (exportableQuestions.length === 0) {
    return res.status(404).json({
      message: "No new completed questions are marked for downloading.",
    });
  }

  // Convert to CSV format using json2csv
  const json2csvParser = new Parser({
    fields: [
      "id",
      "URL",
      "Category1",
      "Category2",
      "Category3",
      "Question",
      "Answer (TEXT)",
      "Answer (HTML)",
      "checkedComplete",
      "canDownload",
    ],
  });

  const csv = json2csvParser.parse(exportableQuestions);

  // Set headers for file download
  res.header("Content-Type", "text/csv");
  res.attachment(`${file}_completed.csv`);
  res.send(csv);
});

// Route to get questions and answers from a specific file with pagination
app.get("/questions", async (req, res) => {
  const file = req.query.file;
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;

  const db = await getDatabase(file);
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedQuestions = db.data.questions.slice(startIndex, endIndex);

  res.json({
    questions: paginatedQuestions,
    total: db.data.questions.length,
  });
});

// Route to save only changed questions to the file
app.post("/save-changes", async (req, res) => {
  const { file, changes } = req.body;
  const db = await getDatabase(file);

  changes.forEach((change) => {
    const index = db.data.questions.findIndex((q) => q.id === change.id);
    if (index !== -1) {
      db.data.questions[index] = {
        ...db.data.questions[index],
        ...change,
        checkedComplete: false, // Reset to false on change
        canDownload: false, // Reset to false on change
      };
    }
  });

  await db.write();
  res.send(`Changes saved for file ${file}.json`);
});

// Route to reset the isDownloaded status of a specific question
app.post("/reset-download-status", async (req, res) => {
  const { file, id, canDownload } = req.body;
  const db = await getDatabase(file);

  const question = db.data.questions.find((q) => q.id === id);
  if (question) {
    question.canDownload = canDownload; // Set the canDownload status based on the checkbox
    await db.write(); // Save the change to the database
    res.send(`Download status updated for question ID ${id} in ${file}.json`);
  } else {
    res.status(404).send("Question not found.");
  }
});

// Route to save progress for a specific file
app.post("/save-progress", async (req, res) => {
  const { file, id, completed } = req.body;
  const db = await getDatabase(file);

  const question = db.data.questions.find((q) => q.id === id);
  if (question) {
    question.checkedComplete = completed;
    await db.write();
    res.send(`Progress saved for question ${id} in ${file}.json`);
  } else {
    res.status(404).send("Question not found.");
  }
});

// Route to delete an entire database (JSON file)
app.delete("/delete-database", async (req, res) => {
  const file = req.query.file;
  const filePath = path.join(dbDirectory, `${file}.json`);

  try {
    await fs.unlink(filePath);
    res.send(`Database ${file}.json deleted successfully.`);
  } catch (error) {
    res.status(500).send("Error deleting database.");
  }
});

// Route to delete an individual question from a database
app.delete("/delete-question", async (req, res) => {
  const { file, id } = req.body;
  const db = await getDatabase(file);

  const index = db.data.questions.findIndex((q) => q.id === id);
  if (index !== -1) {
    db.data.questions.splice(index, 1); // Remove the question from the array
    await db.write();
    res.send(`Question ID ${id} deleted successfully from ${file}.json.`);
  } else {
    res.status(404).send("Question not found.");
  }
});

// Route to list available CSV files
app.get("/list-csv-files", async (req, res) => {
  const files = (await fs.readdir(dbDirectory))
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.basename(file, ".json"));
  res.json(files);
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
