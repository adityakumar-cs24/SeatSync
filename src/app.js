const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const eventRoutes = require('./routes/eventRoutes');
const seatRoutes = require('./routes/seatRoutes');
const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/events', eventRoutes);
app.use('/api/seats', seatRoutes);

module.exports = app;