require('dotenv').config();

const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const port = process.env.PORT;
const mysql = require("mysql2");
const OpenAI = require('openai');
const {Pinecone} = require('@pinecone-database/pinecone');
const cheerio = require("cheerio");

const bodyParser = require("body-parser");
app.use(bodyParser.json());

// MySQL 연결 설정
const db = mysql.createConnection({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
});

// MySQL 연결
db.connect((err) => {
    if (err) {
        console.error("MySQL 연결 실패: ", err);
        return;
    }
    console.log("MySQL 연결 성공!");
});

// OpenAI 설정
const openai = new OpenAI({
    apiKey: process.env.OPEN_AI_API_KEY
});

// Pinecone 설정 (새로운 API 방식)
const pinecone = new Pinecone({
    apiKey: process.env.PINECORN_API_KEY
});

const index = pinecone.index(process.env.PINECORN_INDEX);

app.get("/", async (req, res) => {
    res.status(200).send("Just Read It Server Working");
});

// getBookList 엔드포인트
app.get("/getBookList", (req, res) => {
    const query = "SELECT id, title, author, publisher, cover, positionX, positionY FROM Book";

    db.query(query, (err, results) => {
        if (err) {
            console.error("데이터 조회 실패: ", err);
            res.status(500).send("데이터 조회 실패");
            return;
        }
        res.json(results);
    });
});

// addBook 엔드포인트
app.post("/addBook", (req, res) => {
    const {id, title, author, publisher, cover, positionX, positionY} = req.body;

    if (!id || !title || !publisher || !positionX || !positionY) {
        res.status(400).send("필수 필드가 누락되었습니다.");
        return;
    }

    const query = `
        INSERT INTO Book (id, title, author, publisher, cover, positionX, positionY)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [id, title, author, publisher, cover, positionX, positionY];

    db.query(query, values, (err, results) => {
        if (err) {
            console.error("데이터 추가 실패: ", err);
            res.status(500).send("데이터 추가 실패");
            return;
        }

        console.log("새 책 데이터가 성공적으로 추가되었습니다:", results);
        res.status(201).send("책 데이터가 성공적으로 추가되었습니다.");
    });
});

// updateBookPosition 엔드포인트
app.post("/updateBookPosition", (req, res) => {
    const {id, positionX, positionY} = req.body;

    if (!id || positionX === undefined || positionY === undefined) {
        res.status(400).send("필수 필드가 누락되었습니다.");
        return;
    }

    const query = `
        UPDATE Book
        SET positionX = ?,
            positionY = ?
        WHERE id = ?
    `;

    const values = [positionX, positionY, id];

    db.query(query, values, (err, results) => {
        if (err) {
            console.error("데이터 업데이트 실패: ", err);
            res.status(500).send("데이터 업데이트 실패");
            return;
        }

        console.log(`책 ID ${id}의 위치가 업데이트되었습니다.`);
        res.status(200).send("책 위치가 성공적으로 업데이트되었습니다.");
    });
});

app.get("/getBookNotes", (req, res) => {
    const {bookId} = req.query;  // URL 파라미터로 bookId 받기

    if (!bookId) {
        res.status(400).send("bookId는 필수 파라미터입니다.");
        return;
    }

    const query = "SELECT id, bookId, type, title, text FROM Note WHERE bookId = ?";

    db.query(query, [bookId], (err, results) => {
        if (err) {
            console.error("노트 조회 실패: ", err);
            res.status(500).send("노트 조회 실패");
            return;
        }

        // type 값을 문자열로 변환 (0 -> 'during', 1 -> 'after')
        const formattedResults = results.map(note => ({
            ...note,
            type: note.type === 0 ? 'during' : 'after'
        }));

        res.json(formattedResults);
    });
});

app.post("/createNote", async (req, res) => {
    const {bookId, type} = req.body;

    // type 변환 ('during' -> 0, 'after' -> 1)
    let typeValue;
    if (type === 'after') {
        typeValue = 1;
    } else if (type === 'during') {
        typeValue = 0;
    } else {
        res.status(400).send("type은 'during' 또는 'after'이어야 합니다.");
        return;
    }

    try {
        // MySQL에 노트 추가
        const query = `
            INSERT INTO Note (bookId, type, title, text)
            VALUES (?, ?, ?, ?)
        `;
        const values = [bookId, typeValue, "Untitled", ''];

        const [results] = await db.promise().query(query, values);
        const noteId = results.insertId;

        res.json({
            status: "success",
            message: "노트가 성공적으로 생성되었습니다.",
            noteId: noteId
        });

    } catch (err) {
        console.error("노트 생성 실패:", err);
        res.status(500).json({
            status: "error",
            message: "노트 생성에 실패했습니다."
        });
    }
});

app.post("/saveNote", async (req, res) => {
    const {bookId, bookTitle, noteId, text} = req.body;

    if (!bookId || !bookTitle || !noteId || text === undefined) {
        res.status(400).send("필수 필드가 누락되었습니다.");
        return;
    }

    const query = `
        UPDATE Note
        SET text = ?
        WHERE id = ?
        AND bookId = ?
    `;
    const values = [text, noteId, bookId];

    db.query(query, values, async (err, results) => {
        if (err) {
            console.error("MySQL 업데이트 실패: ", err);
            res.status(500).send("노트 저장 실패");
            return;
        }

        if (results.affectedRows > 0) {
            console.log(`노트 ID ${noteId}, 책 ID ${bookId}가 MySQL에 성공적으로 저장되었습니다.`);

            try {
                const links = extractLinksFromText(text);

                const deleteQuery = "DELETE FROM BookConnection WHERE baseNoteId = ?";
                db.query(deleteQuery, [noteId], (deleteErr) => {
                    if (deleteErr) {
                        console.error("기존 BookConnection 데이터 삭제 실패: ", deleteErr);
                        return;
                    }
                    console.log(`기존 BookConnection 데이터 삭제 완료 (baseNoteId: ${noteId})`);
                
                    // 새로운 데이터 삽입
                    const bookQuery = `
                        INSERT INTO BookConnection (baseNoteId, baseBookId, targetBookId)
                        VALUES ?
                    `;
                    const bookValues = [];
                
                    // book 링크에 대한 데이터 준비
                    links.bookIds.forEach(targetBookId => {
                        bookValues.push([noteId, bookId, targetBookId]);
                    });
                
                    // 데이터베이스에 저장
                    if (bookValues.length > 0) {
                        db.query(bookQuery, [bookValues], (insertErr) => {
                            if (insertErr) {
                                console.error("BookConnection 데이터 추가 실패: ", insertErr);
                                return;
                            }
                            console.log("새로운 BookConnection 데이터 추가 완료");
                        });
                    } else {
                        console.log("추가할 BookConnection 데이터가 없습니다.");
                    }

                    // note 링크들에 대한 정보를 가져오는 쿼리
                    if (links.noteIds.length > 0) {
                        const noteQuery = `
                            SELECT id, bookId
                            FROM Note
                            WHERE id IN (?)
                        `;
                        
                        db.query(noteQuery, [links.noteIds], (noteErr, noteResults) => {
                            if (noteErr) {
                                console.error("Note 정보 조회 실패: ", noteErr);
                                return;
                            }
                            
                            // note 링크에 대한 데이터 준비
                            const noteValues = [];
                            noteResults.forEach(noteResult => {
                                noteValues.push([noteId, bookId, noteResult.bookId, noteResult.id]);
                            });

                            // 데이터베이스에 저장
                            if (noteValues.length > 0) {
                                const insertQuery = `
                                    INSERT INTO NoteConnection (baseNoteId, baseBookId, targetBookId, targetNoteId)
                                    VALUES ?
                                `;
                                
                                db.query(insertQuery, [noteValues], (insertErr) => {
                                    if (insertErr) {
                                        console.error("NoteConnection 데이터 추가 실패: ", insertErr);
                                        return;
                                    }
                                    console.log("새로운 NoteConnection 데이터 추가 완료");
                                });
                            } else {
                                console.log("추가할 NoteConnection 데이터가 없습니다.");
                            }
                        });
                    }
                });

                const namespace = index.namespace("justReadIt");

                // 기존 벡터 삭제 로직 개선
                try {
                    // 삭제할 ID 목록 생성 (prefix 기반)
                    const prefix = `${noteId}-`;
                    const idsToDelete = [];
                    const maxVectors = 1000; // 임시 최대 삭제 개수 설정

                    // 벡터 ID를 최대 개수만큼 나열 (Serverless는 메타데이터 필터 불가)
                    for (let i = 0; i < maxVectors; i++) {
                        idsToDelete.push(`${prefix}${i}`);
                    }

                    // Pinecone에서 삭제
                    await namespace.deleteMany(idsToDelete);
                    console.log(`노트 ID ${noteId}에 해당하는 기존 벡터가 Pinecone에서 삭제되었습니다.`);
                } catch (deleteErr) {
                    console.warn(`노트 ID ${noteId}의 기존 벡터 삭제 중 오류 발생:`, deleteErr);
                }


                // 텍스트를 문장 단위로 분리
                const sentences = extractSentencesFromHTML(text);

                console.log(sentences);

                // 문장들을 벡터화 후 Pinecone에 저장
                const embeddings = await Promise.all(
                    sentences.map(async (sentence, index) => {
                        const embeddingResponse = await openai.embeddings.create({
                            model: "text-embedding-3-large",
                            input: sentence,
                        });
                        const vector = embeddingResponse.data[0].embedding;

                        return {
                            id: `${noteId}-${index}`,
                            values: vector,
                            metadata: {
                                bookId: bookId,
                                bookTitle: bookTitle,
                                noteId: noteId,
                                sentence: sentence,
                            },
                        };
                    })
                );

                // 벡터 저장 시 오류 처리 추가
                if (embeddings.length > 0) {
                    await namespace.upsert(embeddings);
                    console.log(`노트 ID ${noteId}, 책 ID ${bookId}의 문장들이 Pinecone에 성공적으로 저장되었습니다.`);
                } else {
                    console.warn(`노트 ID ${noteId}의 문장이 없어 Pinecone에 저장할 벡터가 없습니다.`);
                }

                res.status(200).send("노트와 문장 벡터가 성공적으로 저장되었습니다.");
            } catch (vectorErr) {
                console.error("Pinecone 저장 중 오류 발생: ", vectorErr);
                res.status(500).send("노트 저장은 성공했지만 벡터화 및 Pinecone 작업에 실패했습니다.");
            }
        } else {
            console.warn(`노트 ID ${noteId}, 책 ID ${bookId}가 존재하지 않습니다.`);
            res.status(404).send("노트가 존재하지 않습니다.");
        }
    });
});

// 텍스트에서 링크를 추출하고 출력하는 함수
function extractLinksFromText(htmlText) {
    const $ = cheerio.load(htmlText);
    const links = {
        bookIds: [],
        noteIds: []
    };

    console.log("=== Detected Internal Links ===");
    $("a").each((_, element) => {
        const href = $(element).attr("href");

        // /justreadit/book/{id} 링크 처리
        if (href && href.startsWith("/justreadit/book/")) {
            const bookId = href.split("/").pop();
            console.log(`Found Book Link: ${href}`);
            links.bookIds.push(bookId);
        }

        // /justreadit/note/{id} 링크 처리
        if (href && href.startsWith("/justreadit/note/")) {
            const noteId = href.split("/").pop();
            console.log(`Found Note Link: ${href}`);
            links.noteIds.push(noteId);
        }
    });

    return links;
}

/**
 * HTML 텍스트에서 문장을 추출하는 함수
 */
function extractSentencesFromHTML(htmlText) {
    const $ = cheerio.load(htmlText);
    const sentences = new Set(); // 중복 제거를 위해 Set 사용

    $("a").replaceWith("\n");

    $("*").each((_, element) => {
        const textContent = $(element).text().trim();
        if (textContent) {
            splitAndAddSentences(textContent, sentences);
        }
    });

    return Array.from(sentences); // Set을 배열로 변환
}

// 문장을 나누고 중복 제거를 위해 Set에 추가하는 함수
function splitAndAddSentences(text, sentences) {
    // 태그가 다르면 무조건 분리
    const splitByTags = text.split(/\s*[\n\r]+\s*/);

    splitByTags.forEach((segment) => {
        // 문장 나누기: 온점, 느낌표, 물음표 기준으로 분리
        const splitSentences = segment.split(/(?<=[.!?])\s*/);

        splitSentences.forEach((sentence) => {
            const cleanSentence = sentence.trim();
            if (cleanSentence.length > 0) {
                sentences.add(cleanSentence); // 중복 제거
            }
        });
    });
}

app.post("/searchNoteByVector", async (req, res) => {
    const {searchText, excludeNoteId} = req.body; // 검색 키워드와 제외할 노트 ID

    try {
        // 검색 텍스트를 벡터화
        const queryEmbedding = await openai.embeddings.create({
            model: "text-embedding-3-large",
            input: searchText
        });
        const queryVector = queryEmbedding.data[0].embedding;

        // Pinecone에서 유사도 검색 수행
        // const searchResponse = await index.query({
        //     vector: queryVector,
        //     // filter: {
        //     //     noteId: { $ne: excludeNoteId } // 제외할 노트 ID
        //     // },
        //     includeMetadata: true,
        //     topK: 10 // 상위 10개 결과 반환
        // });
        const searchResponse = await index.namespace("justReadIt").query
        ({
            vector: queryVector,
            topK: 3,
            includeValues: true,
            includeMetadata: true,
        })

        console.log(searchResponse.matches)

        // 결과 포맷팅
        const results = searchResponse.matches.map(match => ({
            bookId: match.metadata.bookId, // 책 ID
            bookTitle: match.metadata.bookTitle, // 책 제목
            noteId: match.metadata.noteId,  // 노트 ID
            sentence: match.metadata.sentence, // 실제 문장 텍스트
            similarity: match.score // 유사도 점수
        }));

        res.json({
            status: "success",
            results: results
        });
    } catch (err) {
        console.error("검색 실패:", err);
        res.status(500).json({
            status: "error",
            message: "검색에 실패했습니다."
        });
    }
});

app.post("/getNoteInfo", (req, res) => {
    const { noteId } = req.body;

    if (!noteId) {
        return res.status(400).json({
            status: "error",
            message: "noteId is required"
        });
    }

    const query = `
        SELECT 
            n.title as noteTitle,
            n.text,
            b.id as bookId,
            b.title as bookTitle,
            b.author,
            b.publisher,
            b.cover
        FROM Note n
        JOIN Book b ON n.bookId = b.id
        WHERE n.id = ?
    `;

    db.query(query, [noteId], (err, results) => {
        if (err) {
            console.error("노트 정보 조회 실패:", err);
            return res.status(500).json({
                status: "error",
                message: "Failed to fetch note information"
            });
        }

        if (results.length === 0) {
            return res.status(404).json({
                status: "error",
                message: "Note not found"
            });
        }

        const noteInfo = results[0];
        res.status(200).json({
            status: "success",
            data: {
                noteTitle: noteInfo.noteTitle,
                text: noteInfo.text,
                book: {
                    id: noteInfo.bookId,
                    title: noteInfo.bookTitle,
                    author: noteInfo.author,
                    publisher: noteInfo.publisher,
                    cover: noteInfo.cover
                }
            }
        });
    });
});

app.post("/searchBook", (req, res) => {
    const { keyword } = req.body;

    if (!keyword || keyword.trim() === "") {
        return res.status(400).json({
            status: "error",
            message: "검색어를 입력해주세요."
        });
    }

    // LIKE 쿼리를 사용하여 검색
    const query = `
        SELECT id, title, author, publisher, cover
        FROM Book
        WHERE title LIKE ? OR author LIKE ? OR publisher LIKE ?
    `;

    const searchKeyword = `%${keyword}%`; // 키워드에 LIKE 패턴 적용
    db.query(query, [searchKeyword, searchKeyword, searchKeyword], (err, results) => {
        if (err) {
            console.error("책 검색 실패:", err);
            return res.status(500).json({
                status: "error",
                message: "책 검색 중 오류가 발생했습니다."
            });
        }

        if (results.length === 0) {
            return res.status(404).json({
                status: "error",
                message: "검색 결과가 없습니다."
            });
        }

        // 결과 반환
        res.status(200).json({
            status: "success",
            data: results
        });
    });
});

app.post("/searchBookById", (req, res) => {
    const { id } = req.body;

    if (!id) {
        return res.status(400).json({
            status: "error",
            message: "책 ID를 입력해주세요."
        });
    }

    const query = `
        SELECT id, title, author, publisher, cover
        FROM Book
        WHERE id = ?
    `;

    db.query(query, [id], (err, results) => {
        if (err) {
            console.error("책 검색 실패:", err);
            return res.status(500).json({
                status: "error",
                message: "책 검색 중 오류가 발생했습니다."
            });
        }

        if (results.length === 0) {
            return res.status(404).json({
                status: "error",
                message: "해당 ID의 책을 찾을 수 없습니다."
            });
        }

        // 결과 반환
        res.status(200).json({
            status: "success",
            data: results[0] // 단일 책 정보 반환
        });
    });
});

server.listen(port, () => console.log(`Server running on ${port}`));